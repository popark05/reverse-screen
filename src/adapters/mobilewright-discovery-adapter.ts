import { createHash, randomUUID } from "node:crypto";
import { android, ios } from "mobilewright";
import type { CapturedEvidence } from "../domain/evidence-artifact.js";
import type { DiscoveryEvent, Platform } from "../domain/discovery-event.js";
import type { DiscoverySession } from "../domain/discovery-session.js";
import type { DiscoveryActionRequest } from "../domain/discovery-action.js";
import { deterministicUuid } from "../domain/identity.js";

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
  click(): Promise<void>;
  fill(value: string): Promise<void>;
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
  getByRole(role: string, options?: { name?: string }): WebLocator;
  getByLabel(label: string): WebLocator;
  getByTestId(testId: string): WebLocator;
  close(): Promise<void>;
}
interface WebViewLocator {
  count(): Promise<number>;
  page(): Promise<WebPage>;
  nth(index: number): { page(): Promise<WebPage> };
}
interface NativeLocator {
  tap(): Promise<void>;
  fill(value: string): Promise<void>;
}
interface MobilewrightDevice {
  id: string;
  screen: {
    viewTree(): Promise<ViewNode[]>;
    getByWebView(): WebViewLocator;
    getByRole(role: string, options?: { name?: string }): NativeLocator;
    getByLabel(label: string): NativeLocator;
    getByTestId(testId: string): NativeLocator;
    screenshot(): Promise<Buffer>;
    goBack?(): Promise<void>;
  };
  getForegroundApp(): Promise<{ bundleId: string; name?: string; version?: string }>;
  screenSize(): Promise<{ width: number; height: number; scale: number }>;
  close(): Promise<void>;
}
interface LaunchOptions { deviceId: string; bundleId: string; installApps?: string | string[]; autoAppLaunch?: boolean; }
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
  return raw?.clickable === true || raw?.accessible === true ||
    (node.type === "android.view.View" && typeof node.label === "string" && node.label.trim().length > 0);
}

function isClickable(node: ViewNode): boolean {
  const raw = (node as ViewNode & { raw?: Record<string, unknown> }).raw;
  return raw?.clickable === true || raw?.clickable === "true";
}
/** Mirrors Mobilewright's name-from-content: own label/text, else descendants' names joined. */
function accessibleName(node: ViewNode): string {
  const own = node.label?.trim() || (isEditable(node) ? "" : node.text?.trim());
  if (own) return own;
  return (node.children ?? []).map(accessibleName).filter((name) => name !== "").join(" ");
}
/** Nodes Mobilewright resolves for getByRole("button"): button types, or clickable plain Views (Jetpack Compose). */
function matchesButtonRole(node: ViewNode): boolean {
  const bare = node.type.toLowerCase().split(".").pop() ?? "";
  if (bare === "view") return isClickable(node);
  return ["button", "imagebutton", "floatingactionbutton", "materialbutton", "appcompatbutton"].includes(bare);
}
function hasActionableDescendant(node: ViewNode): boolean {
  return (node.children ?? []).some((child) =>
    isClickable(child) || (child.type === "android.view.View" && !!child.label?.trim()) || hasActionableDescendant(child));
}
/** Android resource IDs look like "<package>:id/<name>". */
function resourcePackages(node: ViewNode, into = new Set<string>()): Set<string> {
  for (const id of [node.identifier, node.resourceId]) {
    const match = id?.match(/^([A-Za-z0-9_.]+):id\//);
    if (match) into.add(match[1]!);
  }
  for (const child of node.children ?? []) resourcePackages(child, into);
  return into;
}
/**
 * Drops window roots owned by another package (e.g. Samsung Edge panel, other overlays).
 * A root is foreign when it carries resource IDs and none belong to the app or the Android framework.
 * Apps whose applicationId has a build suffix (com.example.app.debug) keep IDs of the base package.
 */
export function excludeForeignWindows(roots: ViewNode[], bundleId: string): ViewNode[] {
  const ownsPackage = (pkg: string) => pkg === bundleId || bundleId.startsWith(`${pkg}.`) || pkg.startsWith(`${bundleId}.`);
  return roots.filter((root) => {
    const packages = [...resourcePackages(root)].filter((pkg) => pkg !== "android");
    return packages.length === 0 || packages.some(ownsPackage);
  });
}
/**
 * Human-readable screen name: the topmost short text in the upper quarter of its window
 * (a top app bar or dialog title). Falls back to the application name.
 */
export function inferScreenName(roots: ViewNode[]): string | undefined {
  let best: { name: string; y: number; x: number } | undefined;
  const visit = (node: ViewNode, root: ViewNode): void => {
    const text = isEditable(node) ? "" : node.text?.trim() ?? "";
    const withinHeader = node.bounds.y - root.bounds.y <= root.bounds.height * 0.25;
    if (text && node.isVisible && withinHeader && text.length <= 40 && !text.includes("\n") &&
        (!best || node.bounds.y < best.y || (node.bounds.y === best.y && node.bounds.x < best.x))) {
      best = { name: text, y: node.bounds.y, x: node.bounds.x };
    }
    for (const child of node.children ?? []) visit(child, root);
  };
  for (const root of roots) if (root.bounds.height > 0) visit(root, root);
  return best?.name;
}

export class MobilewrightDiscoveryAdapter {
  private readonly webViewContexts = new Map<string, Map<number, { contextInstanceId: string; screenId: string; stateId: string; url: string }>>();

  constructor(private readonly options: MobilewrightDiscoveryOptions, private readonly factory: LauncherFactory = defaultFactory) {
    if (!options.bundleId.trim()) throw new Error("MOBILE_APP_BUNDLE_ID is required");
  }

  async observe(session: DiscoverySession): Promise<DiscoveryEvent[]> {
    return (await this.observeInternal(session, false)).events;
  }

  async observeWithEvidence(session: DiscoverySession): Promise<MobilewrightDiscoveryResult> {
    return this.observeInternal(session, true);
  }

  async executeAction(session: DiscoverySession, request: DiscoveryActionRequest): Promise<DiscoveryEvent> {
    if (session.platform !== "ios" && session.platform !== "android") {
      throw new Error(`mobilewright_action_platform_unsupported:${session.platform}`);
    }
    if (request.action === "fill" && request.input_value === undefined) {
      throw new Error("mobilewright_action_input_value_required");
    }
    if (request.action === "back" && request.context_type !== "native") {
      throw new Error("mobilewright_back_requires_native_context");
    }
    if (request.action !== "back" && request.locator_strategy === "role_name" && (!request.locator_role || !request.locator_name)) {
      throw new Error("mobilewright_action_role_locator_incomplete");
    }
    if (request.action !== "back" && request.locator_strategy !== "role_name" && !request.locator_value) {
      throw new Error("mobilewright_action_locator_value_required");
    }

    const launcher = session.platform === "ios" ? this.factory.ios : this.factory.android;
    const device = await launcher.launch({
      deviceId: session.target_id,
      bundleId: this.options.bundleId,
      autoAppLaunch: false,
      ...(this.options.installAppPath ? { installApps: this.options.installAppPath } : {})
    });
    let page: WebPage | undefined;
    try {
      if (request.action === "back") {
        if (!device.screen.goBack) throw new Error("mobilewright_back_unsupported");
        await device.screen.goBack();
      } else if (request.context_type === "native") {
        const locator = request.locator_strategy === "label"
          ? device.screen.getByLabel(request.locator_value!)
          : request.locator_strategy === "test_id"
            ? device.screen.getByTestId(request.locator_value!)
            : device.screen.getByRole(request.locator_role!, { name: request.locator_name! });
        if (request.action === "tap") await locator.tap();
        else await locator.fill(request.input_value!);
      } else {
        const webViews = device.screen.getByWebView();
        const webViewIndex = request.webview_index ?? 0;
        const count = await webViews.count();
        if (count === 0 && webViewIndex === 0) {
          // Android may flatten WebView DOM nodes into the native accessibility tree,
          // even though Mobilewright's bridge can still attach to the page.
          try { page = await webViews.page(); }
          catch { throw new Error("mobilewright_action_webview_not_found"); }
        } else {
          if (webViewIndex >= count) throw new Error("mobilewright_action_webview_not_found");
          page = await webViews.nth(webViewIndex).page();
        }
        const locator = request.locator_strategy === "label"
          ? page.getByLabel(request.locator_value!)
          : request.locator_strategy === "test_id"
            ? page.getByTestId(request.locator_value!)
            : page.getByRole(request.locator_role!, { name: request.locator_name! });
        if (request.action === "tap") await locator.click();
        else await locator.fill(request.input_value!);
      }

      return {
        event_id: randomUUID(),
        session_id: session.session_id,
        sequence: 1,
        event_type: "action_executed",
        occurred_at: new Date().toISOString(),
        platform: session.platform as Platform,
        ...(request.screen_id ? { screen_id: request.screen_id } : {}),
        ...(request.state_id ? { state_id: request.state_id } : {}),
        payload: {
          context_type: request.context_type,
          ...(request.target_element_key ? { target_element_key: request.target_element_key } : {}),
          action: request.action,
          ...(request.locator_strategy ? { locator_strategy: request.locator_strategy } : {}),
          ...(request.locator_value ? { locator_value: request.locator_value } : {}),
          ...(request.locator_role ? { locator_role: request.locator_role } : {}),
          ...(request.locator_name ? { locator_name: request.locator_name } : {}),
          ...(request.context_type === "webview" ? { webview_index: request.webview_index ?? 0 } : {}),
          outcome: "succeeded",
          value_redacted: request.action === "fill"
        }
      };
    } finally {
      await page?.close().catch(() => {});
      await device.close();
    }
  }

  /**
   * Jetpack Compose often reports a clickable View without its own name whose caption is on a
   * child Text (bottom navigation items, list rows, dialog buttons). Mobilewright resolves
   * getByRole("button", { name }) against the descendants' text, so expose that as the locator
   * when the name is unique on screen and no descendant is separately actionable.
   */
  private contentNamedButtonLocator(node: ViewNode, buttonNameCounts: Map<string, number>) {
    if (!isClickable(node) || !matchesButtonRole(node) || hasActionableDescendant(node)) return undefined;
    const name = accessibleName(node);
    if (!name || name.length > 500 || buttonNameCounts.get(name) !== 1) return undefined;
    return { locator_strategy: "role_name", locator_role: "button", locator_name: name, locator_source: "descendant_text" };
  }

  private async observeInternal(session: DiscoverySession, captureEvidence: boolean): Promise<MobilewrightDiscoveryResult> {
    if (session.platform !== "ios" && session.platform !== "android") {
      throw new Error(`mobilewright_discovery_platform_unsupported:${session.platform}`);
    }
    const launcher = session.platform === "ios" ? this.factory.ios : this.factory.android;
    const device = await launcher.launch({
      deviceId: session.target_id,
      bundleId: this.options.bundleId,
      autoAppLaunch: session.status === "running",
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
      const appTree = excludeForeignWindows(tree, app.bundleId || this.options.bundleId);
      const flattened = flattenTree(appTree, maxElements);
      // Screen identity = layout structure (no visible text); state identity = structure + text + toggles.
      // Both are deterministic, so a revisited screen/state keeps its ID within the application.
      const structureSignature = flattened.map(({ node, depth }) => [depth, node.type, node.identifier ?? "", node.resourceId ?? ""].join("|")).join("\n");
      const nativeSignature = flattened.map(({ node }) => [node.type, node.identifier ?? "", node.resourceId ?? "", node.label ?? "", isEditable(node) ? "" : node.text ?? "", node.isSelected ? "s" : "", node.isChecked ? "c" : ""].join("|")).join("\n");
      const screenKey = `native:${stableKey([session.platform, app.bundleId, structureSignature].join("|"))}`;
      const stateKey = `native-state:${stableKey([session.platform, app.bundleId, nativeSignature].join("|"))}`;
      const nativeScreenId = deterministicUuid("reverse-screen/screen", session.application_id, screenKey);
      const nativeStateId = deterministicUuid("reverse-screen/state", nativeScreenId, stateKey);
      const appName = app.name ?? app.bundleId;
      const inferredName = inferScreenName(appTree);
      const excludedWindowCount = tree.length - appTree.length;
      addEvent({
        event_type: "screen_observed", screen_id: nativeScreenId, state_id: nativeStateId, occurred_at: observedAt,
        payload: {
          context_type: "native", application_id: session.application_id, target_id: session.target_id,
          screen_key: screenKey, state_key: stateKey,
          name: inferredName ?? appName, name_source: inferredName ? "header_text" : "application_name",
          app_name: appName, bundle_id: app.bundleId, app_version: app.version,
          element_count: flattened.length, tree_node_count: countNodes(appTree), truncated: flattened.length < countNodes(appTree),
          ...(excludedWindowCount > 0 ? { excluded_foreign_window_count: excludedWindowCount } : {}),
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

      const buttonNameCounts = new Map<string, number>();
      for (const { node } of flattened) {
        if (!matchesButtonRole(node)) continue;
        const name = accessibleName(node);
        if (name) buttonNameCounts.set(name, (buttonNameCounts.get(name) ?? 0) + 1);
      }
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
        if (isActionable(node, role)) {
          const actionLocator = node.identifier
            ? { locator_strategy: "test_id", locator_value: node.identifier }
            : label
              ? { locator_strategy: "label", locator_value: label }
              : text
                ? { locator_strategy: "role_name", locator_role: role, locator_name: text }
                : this.contentNamedButtonLocator(node, buttonNameCounts);
          if (actionLocator) addEvent({
            event_type: "action_candidate", screen_id: nativeScreenId, state_id: nativeStateId, occurred_at: observedAt,
            payload: {
              context_type: "native", action: isEditable(node) ? "fill" : "tap",
              target_element_key: elementKey, enabled: node.isEnabled,
              ...actionLocator
            }
          });
        }
      }

      const previousWebViews = this.webViewContexts.get(session.session_id) ?? new Map<number, { contextInstanceId: string; screenId: string; stateId: string; url: string }>();
      const currentWebViews = new Map<number, { contextInstanceId: string; screenId: string; stateId: string; url: string }>();
      const webViewEnumerationSucceeded = await this.observeWebViews(
        device, session, observedAt, nativeScreenId, nativeStateId, addEvent, previousWebViews, currentWebViews
      );
      if (webViewEnumerationSucceeded) {
        for (const [index, previous] of previousWebViews) {
          if (currentWebViews.has(index)) continue;
          addEvent({
            event_type: "transition_observed",
            screen_id: nativeScreenId,
            state_id: nativeStateId,
            transition_id: randomUUID(),
            occurred_at: observedAt,
            payload: {
              context_type: "hybrid",
              transition_kind: "context_detachment",
              direction: "webview_to_native",
              source_context_type: "webview",
              target_context_type: "native",
              source_screen_id: previous.screenId,
              source_state_id: previous.stateId,
              target_screen_id: nativeScreenId,
              target_state_id: nativeStateId,
              context_instance_id: previous.contextInstanceId,
              webview_index: index,
              relationship: "context_disappeared",
              navigation_verified: false,
              observation_source: "mobilewright_webview_lifecycle"
            }
          });
        }
        this.webViewContexts.set(session.session_id, currentWebViews);
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
    nativeScreenId: string,
    nativeStateId: string,
    addEvent: (input: Omit<DiscoveryEvent, "event_id" | "session_id" | "sequence" | "platform">) => DiscoveryEvent,
    previousWebViews: Map<number, { contextInstanceId: string; screenId: string; stateId: string; url: string }>,
    currentWebViews: Map<number, { contextInstanceId: string; screenId: string; stateId: string; url: string }>
  ): Promise<boolean> {
    const webViews = device.screen.getByWebView();
    let webViewCount = 0;
    try { webViewCount = await webViews.count(); }
    catch { return false; }
    // Android can expose WebView DOM as flattened native accessibility nodes while
    // its bridge still provides one unambiguous page.
    const flattenedSingleWebView = webViewCount === 0;
    if (flattenedSingleWebView) webViewCount = 1;
    const maxElements = this.options.maxWebViewElements ?? 200;
    let observationComplete = true;
    for (let index = 0; index < webViewCount; index++) {
      let page: WebPage | undefined;
      try {
        page = flattenedSingleWebView ? await webViews.page() : await webViews.nth(index).page();
        const [url, title, html] = await Promise.all([Promise.resolve(page.url()), page.title(), page.content()]);
        const domElements = page.locator("*");
        const domCount = await domElements.count();
        const screenId = randomUUID();
        const stateId = randomUUID();
        const previousContext = previousWebViews.get(index);
        const contextInstanceId = previousContext?.contextInstanceId ?? randomUUID();
        currentWebViews.set(index, { contextInstanceId, screenId, stateId, url });
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
        addEvent({
          event_type: "transition_observed",
          screen_id: nativeScreenId,
          state_id: nativeStateId,
          transition_id: randomUUID(),
          occurred_at: observedAt,
          payload: {
            context_type: "hybrid",
            transition_kind: "context_attachment",
            lifecycle_state: previousContext ? "observed_again" : "attached",
            context_instance_id: contextInstanceId,
            direction: "native_to_webview",
            source_context_type: "native",
            target_context_type: "webview",
            source_screen_id: nativeScreenId,
            source_state_id: nativeStateId,
            target_screen_id: webScreenEvent.screen_id,
            target_state_id: webScreenEvent.state_id,
            webview_index: index,
            relationship: "embedded_context",
            navigation_verified: false,
            observation_source: "mobilewright_webview_attachment"
          }
        });
        if (previousContext) {
          addEvent({
            event_type: "transition_observed",
            screen_id: previousContext.screenId,
            state_id: previousContext.stateId,
            transition_id: randomUUID(),
            occurred_at: observedAt,
            payload: {
              context_type: "hybrid",
              transition_kind: "context_persisted",
              direction: "webview_to_webview",
              source_context_type: "webview",
              target_context_type: "webview",
              source_screen_id: previousContext.screenId,
              source_state_id: previousContext.stateId,
              target_screen_id: screenId,
              target_state_id: stateId,
              context_instance_id: contextInstanceId,
              webview_index: index,
              previous_url: previousContext.url,
              current_url: url,
              relationship: "same_webview_slot_across_observations",
              navigation_verified: false,
              observation_source: "mobilewright_webview_lifecycle"
            }
          });
        }
        let observed = 0;
        const roleLocators = WEB_ROLES.map((role) => page!.getByRole(role));
        const roleCounts = await Promise.all(roleLocators.map((locator) => locator.count().catch(() => 0)));
        for (let roleIndex = 0; roleIndex < WEB_ROLES.length; roleIndex++) {
          if (observed >= maxElements) break;
          const role = WEB_ROLES[roleIndex]!;
          const locator = roleLocators[roleIndex]!;
          const count = roleCounts[roleIndex] ?? 0;
          const ionicButtons = role === "button" ? page.locator("ion-button") : undefined;
          const ionicButtonCount = ionicButtons ? await ionicButtons.count().catch(() => 0) : 0;
          for (let i = 0; i < count && observed < maxElements; i++) {
            const element = locator.nth(i);
            try {
              if (!(await element.isVisible())) continue;
              const [ariaLabel, testId, placeholder, name, id, roleText, bounds, enabled] = await Promise.all([
                element.getAttribute("aria-label"), element.getAttribute("data-testid"),
                element.getAttribute("placeholder"), element.getAttribute("name"), element.getAttribute("id"),
                ["textbox"].includes(role) ? Promise.resolve("") : element.innerText().catch(() => ""),
                element.boundingBox(), element.isEnabled().catch(() => true)
              ]);
              // Ionic's Web Components may expose the correct ARIA role while the
              // role locator omits slotted text. Read the corresponding custom
              // element text as a fallback so its role/name remains actionable.
              let text = roleText;
              if (!text && ionicButtons && i < ionicButtonCount) {
                try { text = await ionicButtons.nth(i).innerText(); } catch { /* optional Ionic fallback */ }
              }
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
              if (enabled && accessibleName && (role === "textbox" || ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option"].includes(role))) {
                addEvent({
                  event_type: "action_candidate", screen_id: screenId, state_id: stateId, occurred_at: observedAt,
                  payload: {
                    context_type: "webview", webview_index: index,
                    action: role === "textbox" ? "fill" : "tap",
                    target_element_key: key, enabled,
                    locator_strategy: "role_name", locator_role: role, locator_name: accessibleName
                  }
                });
              }
              observed++;
            } catch { /* A DOM node can detach during a live observation. */ }
          }
        }
      } catch (error) {
        if (flattenedSingleWebView && !page) {
          // No bridge page means this is a native-only app (or the WebView detached).
          return true;
        }
        observationComplete = false;
        addEvent({
          event_type: "error", occurred_at: observedAt,
          payload: { context_type: "webview", webview_index: index, error: error instanceof Error ? error.message : String(error) }
        });
      } finally {
        await page?.close().catch(() => {});
      }
    }
    return observationComplete;
  }
}
