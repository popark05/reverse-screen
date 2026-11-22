import { createHash, randomUUID } from "node:crypto";
import { android, ios } from "mobilewright";
import type { DiscoveryEvent, Platform } from "../domain/discovery-event.js";
import type { DiscoverySession } from "../domain/discovery-session.js";

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

interface MobilewrightDevice {
  id: string;
  screen: { viewTree(): Promise<ViewNode[]> };
  getForegroundApp(): Promise<{ bundleId: string; name?: string; version?: string }>;
  screenSize(): Promise<{ width: number; height: number; scale: number }>;
  close(): Promise<void>;
}

interface LaunchOptions {
  deviceId: string;
  bundleId: string;
  installApps?: string | string[];
}

interface Launcher {
  launch(options: LaunchOptions): Promise<MobilewrightDevice>;
}

interface LauncherFactory {
  ios: Launcher;
  android: Launcher;
}

const defaultFactory = {
  ios: ios as unknown as Launcher,
  android: android as unknown as Launcher
} satisfies LauncherFactory;

export interface MobilewrightDiscoveryOptions {
  bundleId: string;
  installAppPath?: string;
  maxElements?: number;
}

interface FlattenedNode {
  node: ViewNode;
  depth: number;
  parentKey?: string;
  elementKey: string;
}

function stableKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function flattenTree(nodes: ViewNode[], maxElements: number): FlattenedNode[] {
  const result: FlattenedNode[] = [];
  const visit = (node: ViewNode, depth: number, path: string, parentKey?: string): void => {
    if (result.length >= maxElements) return;
    const signature = [
      node.type, node.identifier ?? "", node.resourceId ?? "",
      node.label ?? "", node.placeholder ?? "", node.text ?? ""
    ].join("|");
    const elementKey = `native-element:${stableKey(`${path}|${signature}`)}`;
    result.push({ node, depth, ...(parentKey === undefined ? {} : { parentKey }), elementKey });
    for (const [index, child] of (node.children ?? []).entries()) {
      visit(child, depth + 1, `${path}.${index}`, elementKey);
    }
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
  constructor(
    private readonly options: MobilewrightDiscoveryOptions,
    private readonly factory: LauncherFactory = defaultFactory
  ) {
    if (!options.bundleId.trim()) throw new Error("MOBILE_APP_BUNDLE_ID is required");
  }

  async observe(session: DiscoverySession): Promise<DiscoveryEvent[]> {
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
      const maxElements = this.options.maxElements ?? 300;
      const flattened = flattenTree(tree, maxElements);
      const observedAt = new Date().toISOString();
      const screenId = randomUUID();
      const stateId = randomUUID();
      const screenSignature = flattened.map(({ node }) => [
        node.type, node.identifier ?? "", node.resourceId ?? "", node.label ?? "",
        isEditable(node) ? "" : node.text ?? ""
      ].join("|")).join("\n");
      const screenKey = `native:${stableKey([session.platform, app.bundleId, screenSignature].join("|"))}`;
      const events: DiscoveryEvent[] = [];
      let sequence = 0;
      const addEvent = (input: Omit<DiscoveryEvent, "event_id" | "session_id" | "sequence" | "platform">): void => {
        events.push({
          ...input,
          event_id: randomUUID(),
          session_id: session.session_id,
          sequence: ++sequence,
          platform: session.platform as Platform
        });
      };

      addEvent({
        event_type: "screen_observed",
        screen_id: screenId,
        state_id: stateId,
        occurred_at: observedAt,
        payload: {
          application_id: session.application_id,
          target_id: session.target_id,
          screen_key: screenKey,
          name: app.name ?? app.bundleId,
          bundle_id: app.bundleId,
          app_version: app.version,
          element_count: flattened.length,
          tree_node_count: countNodes(tree),
          truncated: flattened.length < countNodes(tree),
          ...(size ? { screen_size: size } : {}),
          observation_source: "mobilewright_accessibility_tree"
        }
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
          event_type: "element_observed",
          screen_id: screenId,
          state_id: stateId,
          occurred_at: observedAt,
          payload: {
            element_key: elementKey,
            element_type: node.type,
            role,
            accessible_name: label || text || node.placeholder || node.identifier || node.resourceId || "",
            ...(text ? { text } : {}),
            ...(node.placeholder ? { placeholder: node.placeholder } : {}),
            visible: node.isVisible,
            enabled: node.isEnabled,
            ...(node.isSelected === undefined ? {} : { selected: node.isSelected }),
            ...(node.isChecked === undefined ? {} : { checked: node.isChecked }),
            depth,
            ...(parentKey ? { parent_element_key: parentKey } : {}),
            bounds: node.bounds,
            locator_candidates: locatorCandidates,
            value_redacted: isEditable(node)
          }
        });
        if (isActionable(node, role)) {
          addEvent({
            event_type: "action_candidate",
            screen_id: screenId,
            state_id: stateId,
            occurred_at: observedAt,
            payload: {
              action: isEditable(node) ? "enter_text" : "tap",
              target_element_key: elementKey,
              enabled: node.isEnabled
            }
          });
        }
      }
      return events;
    } finally {
      await device.close();
    }
  }
}
