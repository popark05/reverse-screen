import { createHash, randomUUID } from "node:crypto";
import { android, ios } from "mobilewright";
import type { CapturedEvidence } from "../domain/evidence-artifact.js";
import type { DiscoveryEvent, Platform } from "../domain/discovery-event.js";
import type { DiscoverySession } from "../domain/discovery-session.js";
import { HybridContextLifecycleTracker } from "../domain/hybrid-context-lifecycle.js";

interface ViewNode {
  type: string;
  label?: string;
  identifier?: string;
  resourceId?: string;
  value?: string;
  text?: string;
  placeholder?: string;
  isVisible: boolean;
  isEnabled: boolean;
  isSelected?: boolean;
  isFocused?: boolean;
  isChecked?: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  children: ViewNode[];
}
interface WebLocator {
  count(): Promise<number>;
  nth(index: number): WebLocator;
  getAttribute(name: string): Promise<string | null>;
  innerText(): Promise<string>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
}
interface WebPage {
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  locator(selector: string): WebLocator;
  getByRole(role: string): WebLocator;
  close(): Promise<void>;
}
interface WebViewLocator {
  count(): Promise<number>;
  nth(index: number): { page(): Promise<WebPage> };
}
interface MobilewrightDevice {
  id: string;
  screen: {
    viewTree(): Promise<ViewNode[]>;
    getByWebView(): WebViewLocator;
    screenshot(): Promise<Buffer>;
  };
  getForegroundApp(): Promise<{ bundleId: string; name?: string; version?: string }>;
  screenSize(): Promise<{ width: number; height: number; scale: number }>;
  close(): Promise<void>;
}
interface LaunchOptions { deviceId: string; bundleId: string; installApps?: string | string[]; }
interface Launcher { launch(options: LaunchOptions): Promise<MobilewrightDevice>; }
interface LauncherFactory { ios: Launcher; android: Launcher; }
const defaultFactory = { ios: ios as unknown as Launcher, android: android as unknown as Launcher } satisfies LauncherFactory;

export interface MobilewrightDiscoveryOptions {
  bundleId: string;
  installAppPath?: string;
  maxElements?: number;
  maxWebViewElements?: number;
}
export interface MobilewrightDiscoveryResult {
  events: DiscoveryEvent[];
  evidence: CapturedEvidence[];
}

interface FlattenedNode { node: ViewNode; depth: number; parentKey?: string; elementKey: string; }
interface WebViewContextObservation {
  contextKey: string;
  screenId: string;
  stateId: string;
  webViewIndex: number;
  url: string;
  title: string;
}
interface WebViewObservationResult {
  contexts: WebViewContextObservation[];
  complete: boolean;
}
const WEB_ROLES = ["button", "link", "textbox", "checkbox", "radio", "switch", "tab", "heading", "img", "listitem", "combobox", "option", "alert", "dialog", "menuitem"];
function stableKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}
function flattenTree(nodes: ViewNode[], maxElements: number): FlattenedNode[] {
  const result: FlattenedNode[] = [];
  const visit = (node: ViewNode, depth: number, path: string, parentKey?: string): void => {
    if (result.length >= maxElements) return;
    const signature = [node.type, node.identifier ?? "", node.resourceId ?? "", node.label ?? "", node.placeholder ?? "", node.text ?? ""].join("|");
    const elementKey = `native-element:${stableKey(`${path}|${signature}`)}`;
    result.push({ node, depth, ...(parentKey === undefined ? {} : { parentKey }), elementKey });
    for (const [index, child] of (node.children ?? []).entries()) visit(child, depth + 1, `${path}.${index}`, elementKey);
  };
  for (const [index, node] of nodes.entries()) visit(node, 0, String(index));
  return result;
}
function countNodes(nodes: ViewNode[]): number {
  return nodes.reduce((count, node) => count + 1 + countNodes(node.children ?? []), 0);
}
function isEditable(node: ViewNode): boolean {
  return /text.?field|edit.?text|search.?field|password/i.test(node.type);
}
function inferRole(node: ViewNode): string {
  const type = node.type.toLowerCase();
  if (/button/.test(type)) return "button";
  if (/secure|password/.test(type)) return "password";
  if (/text.?field|edit.?text|search.?field/.test(type)) return "textbox";
  if (/switch|toggle/.test(type)) return "switch";
  if (/check.?box/.test(type)) return "checkbox";
  if (/radio/.test(type)) return "radio";
  if (/image/.test(type)) return "image";
  if (/tab/.test(type)) return "tab";
  if (/cell|row/.test(type)) return "listitem";
  if (/navigation.?bar|toolbar/.test(type)) return "header";
  if (/static.?text|text.?view|label/.test(type)) return "text";
  return "other";
}
function isActionable(node: ViewNode, role: string): boolean {
  if (!node.isVisible || !node.isEnabled) return false;
  if (isEditable(node) || ["button", "switch", "checkbox", "radio", "tab", "link"].includes(role)) return true;
  const raw = (node as ViewNode & { raw?: Record<string, unknown> }).raw;
  return raw?.clickable === true || raw?.accessible === true;
}

export class MobilewrightDiscoveryAdapter {
  private readonly hybridContextLifecycle = new HybridContextLifecycleTracker();
  constructor(private readonly options: MobilewrightDiscoveryOptions, private readonly factory: LauncherFactory = defaultFactory) {
    if (!options.bundleId.trim()) throw new Error("MOBILE_APP_BUNDLE_ID is required");
  }

  async observe(session: DiscoverySession): Promise<DiscoveryEvent[]> {
    return (await this.observeInternal(session, false)).events;
  }

  async observeWithEvidence(session: DiscoverySession): Promise<MobilewrightDiscoveryResult> {
    return this.observeInternal(session, true);
  }

  private async observeInternal(session: DiscoverySession, captureEvidence: boolean): Promise<MobilewrightDiscoveryResult> {
    if (session.platform !== "ios" && session.platform !== "android") {
      throw new Error(`mobilewright_discovery_platform_unsupported:${session.platform}`);
    }
    const launcher = session.platform === "ios" ? this.factory.ios : this.factory.android;
    const device = await launcher.launch({
      deviceId: session.target_id,
      bundleId: this.options.bundleId,
      ...(this.options.installAppPath ? { installApps: this.options.installAppPath } : {})
    });
    try {
      const [tree, app, size] = await Promise.all([
        device.screen.viewTree(),
        device.getForegroundApp().catch((): { bundleId: string; name?: string; version?: string } => ({ bundleId: this.options.bundleId })),
        device.screenSize().catch(() => undefined)
      ]);
      const observedAt = new Date().toISOString();
      const events: DiscoveryEvent[] = [];
      let sequence = 0;
      const addEvent = (input: Omit<DiscoveryEvent, "event_id" | "session_id" | "sequence" | "platform">): DiscoveryEvent => {
        const event: DiscoveryEvent = {
          ...input, event_id: randomUUID(), session_id: session.session_id,
          sequence: ++sequence, platform: session.platform as Platform
        };
        events.push(event);
        return event;
      };

      let screenshot: Buffer | undefined;
      let screenshotError: string | undefined;
      if (captureEvidence) {
        try { screenshot = await device.screen.screenshot(); }
        catch (error) { screenshotError = error instanceof Error ? error.message : String(error); }
      }

      const maxElements = this.options.maxElements ?? 300;
      const flattened = flattenTree(tree, maxElements);
      const nativeScreenId = randomUUID();
      const nativeStateId = randomUUID();
      const nativeSignature = flattened.map(({ node }) => [node.type, node.identifier ?? "", node.resourceId ?? "", node.label ?? "", isEditable(node) ? "" : node.text ?? ""].join("|")).join("\n");
      addEvent({
        event_type: "screen_observed", screen_id: nativeScreenId, state_id: nativeStateId, occurred_at: observedAt,
        payload: {
          context_type: "native", application_id: session.application_id, target_id: session.target_id,
          screen_key: `native:${stableKey([session.platform, app.bundleId, nativeSignature].join("|"))}`,
          name: app.name ?? app.bundleId, bundle_id: app.bundleId, app_version: app.version,
          element_count: flattened.length, tree_node_count: countNodes(tree), truncated: flattened.length < countNodes(tree),
          ...(size ? { screen_size: size } : {}), observation_source: "mobilewright_accessibility_tree"
        }
      });
      const nativeScreenEvent = events[0]!;
      const evidence: CapturedEvidence[] = screenshot ? [{
        kind: "screenshot", content_type: "image/png", bytes: screenshot,
        captured_at: observedAt, event_id: nativeScreenEvent.event_id
      }] : [];
      if (screenshotError) addEvent({
        event_type: "error", occurred_at: observedAt,
        payload: { context_type: "native", operation: "screenshot", error: screenshotError }
      });

      for (const { node, depth, parentKey, elementKey } of flattened) {
        const role = inferRole(node);
        const label = node.label?.trim() ?? "";
        const text = isEditable(node) ? "" : (node.text?.trim() ?? "");
        const locatorCandidates = [
          ...(node.identifier ? [{ strategy: "accessibility_id", value: node.identifier }] : []),
          ...(node.resourceId ? [{ strategy: "android_uiautomator", value: node.resourceId }] : []),
          ...(label ? [{ strategy: "role_name", value: role, name: label }] : []),
          ...(text && text !== label ? [{ strategy: "text", value: text }] : [])
        ];
        addEvent({
          event_type: "element_observed", screen_id: nativeScreenId, state_id: nativeStateId, occurred_at: observedAt,
          payload: {
            context_type: "native", element_key: elementKey, element_type: node.type, role,
            accessible_name: label || text || node.placeholder || node.identifier || node.resourceId || "",
            ...(text ? { text } : {}), ...(node.placeholder ? { placeholder: node.placeholder } : {}),
            visible: node.isVisible, enabled: node.isEnabled,
            ...(node.isSelected === undefined ? {} : { selected: node.isSelected }),
            ...(node.isChecked === undefined ? {} : { checked: node.isChecked }),
            depth, ...(parentKey ? { parent_element_key: parentKey } : {}), bounds: node.bounds,
            locator_candidates: locatorCandidates, value_redacted: isEditable(node)
          }
        });
        if (isActionable(node, role)) addEvent({
          event_type: "action_candidate", screen_id: nativeScreenId, state_id: nativeStateId, occurred_at: observedAt,
          payload: { context_type: "native", action: isEditable(node) ? "enter_text" : "tap", target_element_key: elementKey, enabled: node.isEnabled }
        });
      }

      const webViewObservation = await this.observeWebViews(device, session, observedAt, addEvent);
      if (webViewObservation?.complete) {
        const lifecycle = this.hybridContextLifecycle.reconcile(
          session.session_id, observedAt, nativeScreenId, nativeStateId, webViewObservation.contexts
        );
        for (const item of lifecycle.active) {
          const screenEvent = events.find((event) =>
            event.event_type === "screen_observed" && event.screen_id === item.context.screenId
          );
          if (screenEvent) {
            screenEvent.transition_id = item.lifecycle.transitionId;
            screenEvent.payload.context_key = item.context.contextKey;
            screenEvent.payload.context_lifecycle = {
              status: "active",
              transition_id: item.lifecycle.transitionId,
              first_seen_at: item.lifecycle.firstSeenAt,
              last_seen_at: item.lifecycle.lastSeenAt,
              observation_count: item.lifecycle.observationCount,
              first_observation_number: item.lifecycle.firstObservationNumber,
              last_observation_number: item.lifecycle.lastObservationNumber
            };
          }
          if (item.isNew) addEvent({
            event_type: "transition_observed",
            screen_id: nativeScreenId,
            state_id: nativeStateId,
            transition_id: item.lifecycle.transitionId,
            occurred_at: observedAt,
            payload: {
              context_type: "hybrid",
              transition_kind: "context_attachment",
              direction: "native_to_webview",
              source_context_type: "native",
              target_context_type: "webview",
              source_screen_id: nativeScreenId,
              source_state_id: nativeStateId,
              target_screen_id: item.context.screenId,
              target_state_id: item.context.stateId,
              webview_index: item.context.webViewIndex,
              relationship: "embedded_context",
              navigation_verified: false,
              observation_source: "mobilewright_webview_attachment",
              context_lifecycle: {
                status: "active",
                first_seen_at: item.lifecycle.firstSeenAt,
                last_seen_at: item.lifecycle.lastSeenAt,
                observation_count: item.lifecycle.observationCount,
                observation_number: lifecycle.observationNumber
              }
            }
          });
        }
        for (const item of lifecycle.detached) addEvent({
          event_type: "transition_observed",
          screen_id: nativeScreenId,
          state_id: nativeStateId,
          transition_id: item.lifecycle.transitionId,
          occurred_at: observedAt,
          payload: {
            context_type: "hybrid",
            transition_kind: "context_detachment",
            direction: "webview_to_native",
            source_context_type: "webview",
            target_context_type: "native",
            source_screen_id: item.context.screenId,
            source_state_id: item.context.stateId,
            target_screen_id: nativeScreenId,
            target_state_id: nativeStateId,
            webview_index: item.context.webViewIndex,
            relationship: "no_longer_observed",
            navigation_verified: false,
            observation_source: "mobilewright_webview_absence",
            closure_reason: "not_present_in_complete_observation",
            context_lifecycle: {
              status: "detached_from_observation",
              first_seen_at: item.lifecycle.firstSeenAt,
              last_seen_at: item.lifecycle.lastSeenAt,
              detached_at: item.detachedAt,
              observation_count: item.lifecycle.observationCount,
              first_observation_number: item.lifecycle.firstObservationNumber,
              last_observation_number: item.lifecycle.lastObservationNumber,
              detached_observation_number: item.observationNumber
            }
          }
        });
      }
      return { events, evidence };
    } finally {
      await device.close();
    }
  }

  private async observeWebViews(
    device: MobilewrightDevice,
    session: DiscoverySession,
    observedAt: string,
    addEvent: (input: Omit<DiscoveryEvent, "event_id" | "session_id" | "sequence" | "platform">) => DiscoveryEvent
  ): Promise<WebViewObservationResult | undefined> {
    let webViewCount = 0;
    try { webViewCount = await device.screen.getByWebView().count(); }
    catch { return undefined; }
    const contexts: WebViewContextObservation[] = [];
    let complete = true;
    const maxElements = this.options.maxWebViewElements ?? 200;
    for (let index = 0; index < webViewCount; index++) {
      let page: WebPage | undefined;
      try {
        page = await device.screen.getByWebView().nth(index).page();
        const [url, title, html] = await Promise.all([Promise.resolve(page.url()), page.title(), page.content()]);
        const domElements = page.locator("*");
        const domCount = await domElements.count();
        const screenId = randomUUID();
        const stateId = randomUUID();
        const snapshotHash = createHash("sha256").update(html).digest("hex");
        const webScreenEvent = addEvent({
          event_type: "screen_observed", screen_id: screenId, state_id: stateId, occurred_at: observedAt,
          payload: {
            context_type: "webview", parent_context_type: "native",
            parent_screen_id: nativeScreenId, parent_state_id: nativeStateId, webview_index: index,
            application_id: session.application_id, target_id: session.target_id, url, title,
            screen_key: `webview:${stableKey([session.platform, url, title, snapshotHash].join("|"))}`,
            dom_snapshot_sha256: snapshotHash, dom_element_count: domCount,
            observed_element_count: Math.min(domCount, maxElements), truncated: domCount > maxElements,
            observation_source: "mobilewright_webview_dom"
          }
        });
        contexts.push({
          contextKey: stableKey([session.platform, index, url, title].join("|")),
          screenId,
          stateId,
          webViewIndex: index,
          url,
          title
        });
        let observed = 0;
        for (const role of WEB_ROLES) {
          if (observed >= maxElements) break;
          const locator = page.getByRole(role);
          const count = await locator.count().catch(() => 0);
          for (let i = 0; i < count && observed < maxElements; i++) {
            const element = locator.nth(i);
            try {
              if (!(await element.isVisible())) continue;
              const [ariaLabel, testId, placeholder, name, id, text, bounds, enabled] = await Promise.all([
                element.getAttribute("aria-label"), element.getAttribute("data-testid"),
                element.getAttribute("placeholder"), element.getAttribute("name"), element.getAttribute("id"),
                ["textbox"].includes(role) ? Promise.resolve("") : element.innerText().catch(() => ""),
                element.boundingBox(), element.isEnabled().catch(() => true)
              ]);
              const accessibleName = ariaLabel || placeholder || name || testId || id || text.trim().slice(0, 200);
              const key = `web-element:${stableKey([index, role, accessibleName, testId ?? "", id ?? "", i].join("|"))}`;
              addEvent({
                event_type: "element_observed", screen_id: screenId, state_id: stateId, occurred_at: observedAt,
                payload: {
                  context_type: "webview", webview_index: index, element_key: key, role,
                  accessible_name: accessibleName, ...(testId ? { test_id: testId } : {}),
                  ...(placeholder ? { placeholder } : {}), ...(text.trim() ? { text: text.trim().slice(0, 500) } : {}),
                  visible: true, enabled, ...(bounds ? { bounds } : {}),
                  locator_candidates: [
                    { strategy: "role_name", value: role, name: accessibleName },
                    ...(testId ? [{ strategy: "test_id", value: testId }] : [])
                  ],
                  value_redacted: role === "textbox"
                }
              });
              observed++;
            } catch { /* A DOM node can detach during a live observation. */ }
          }
        }
      } catch (error) {
        complete = false;
        addEvent({
          event_type: "error", occurred_at: observedAt,
          payload: { context_type: "webview", webview_index: index, error: error instanceof Error ? error.message : String(error) }
        });
      } finally {
        await page?.close().catch(() => {});
      }
    }
    return { contexts, complete };
  }
}
