import { createHash, randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { CapturedEvidence } from "../domain/evidence-artifact.js";
import type { DiscoveryEvent } from "../domain/discovery-event.js";

interface ObservedElement {
  tag: string;
  role: string;
  name: string;
  text: string;
  href?: string;
  inputType?: string;
  testId?: string;
  disabled: boolean;
  visible: boolean;
  selector: string;
}

export interface PlaywrightDiscoveryOptions {
  sessionId: string;
  applicationId: string;
  targetId: string;
  maxElements?: number;
}

function stableKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function inferRole(tag: string, inputType?: string): string {
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "input") {
    if (inputType === "checkbox") return "checkbox";
    if (inputType === "radio") return "radio";
    if (inputType === "submit" || inputType === "button") return "button";
    return "textbox";
  }
  return tag;
}

export class PlaywrightDiscoveryAdapter {
  private sequence = 0;

  constructor(
    private readonly page: Page,
    private readonly options: PlaywrightDiscoveryOptions
  ) {}

  async observe(): Promise<DiscoveryEvent[]> {
    const [url, title, elements] = await Promise.all([
      this.page.url(),
      this.page.title(),
      this.page.locator("body").evaluateAll((bodies) => {
        const body = bodies[0];
        if (!body) return [];
        const selector = 'a,button,input,select,textarea,[role],[tabindex]:not([tabindex="-1"])';
        return Array.from(body.querySelectorAll<HTMLElement>(selector)).map((element) => {
          const tag = element.tagName.toLowerCase();
          const inputType = tag === "input" ? (element as HTMLInputElement).type : undefined;
          const role = element.getAttribute("role") ?? (
            tag === "a" ? "link" :
            tag === "button" ? "button" :
            tag === "textarea" ? "textbox" :
            tag === "select" ? "combobox" :
            tag === "input" ? (inputType === "checkbox" ? "checkbox" : inputType === "radio" ? "radio" : "textbox") :
            tag
          );
          const text = (element.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 500);
          const name = (
            element.getAttribute("aria-label") ||
            element.getAttribute("aria-labelledby") ||
            (tag === "input" || tag === "textarea" ? (element as HTMLInputElement | HTMLTextAreaElement).placeholder : "") ||
            element.getAttribute("alt") ||
            element.getAttribute("title") ||
            text
          ).trim().slice(0, 300);
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          const testId = element.getAttribute("data-testid") ?? undefined;
          const id = element.id ? `#${CSS.escape(element.id)}` : "";
          const selectorValue = id || (testId ? `[data-testid="${CSS.escape(testId)}"]` : tag);
          return {
            tag, role, name, text,
            ...(tag === "a" && (element as HTMLAnchorElement).href ? { href: (element as HTMLAnchorElement).href } : {}),
            ...(inputType ? { inputType } : {}),
            ...(testId ? { testId } : {}),
            disabled: "disabled" in element ? Boolean((element as HTMLButtonElement).disabled) : element.getAttribute("aria-disabled") === "true",
            visible, selector: selectorValue
          };
        });
      })
    ]);

    const observedAt = new Date().toISOString();
    const screenId = randomUUID();
    const stateId = randomUUID();
    const screenKey = `web:${stableKey(new URL(url).origin + new URL(url).pathname)}`;
    const limited = (elements as ObservedElement[]).slice(0, this.options.maxElements ?? 250);
    const events: DiscoveryEvent[] = [this.event({
      event_type: "screen_observed", screen_id: screenId, state_id: stateId,
      occurred_at: observedAt,
      payload: {
        application_id: this.options.applicationId,
        target_id: this.options.targetId,
        screen_key: screenKey,
        name: title || new URL(url).pathname,
        route: new URL(url).pathname,
        url,
        title,
        element_count: limited.length,
        truncated: limited.length < (elements as ObservedElement[]).length
      }
    })];

    for (const element of limited) {
      const elementKey = `web-element:${stableKey([element.tag, element.role, element.name, element.href ?? "", element.selector].join("|"))}`;
      events.push(this.event({
        event_type: "element_observed", screen_id: screenId, state_id: stateId,
        occurred_at: observedAt,
        payload: {
          element_key: elementKey, tag: element.tag, role: element.role,
          accessible_name: element.name, text: element.text,
          visible: element.visible, enabled: !element.disabled,
          locator_candidates: [
            ...(element.testId ? [{ strategy: "test_id", value: element.testId }] : []),
            ...(element.name ? [{ strategy: "role_name", value: element.role, name: element.name }] : []),
            { strategy: "css", value: element.selector }
          ],
          ...(element.href ? { href: element.href } : {}),
          ...(element.inputType ? { input_type: element.inputType } : {})
        }
      }));
      if (["button", "link", "checkbox", "radio"].includes(element.role) || ["input", "textarea", "select"].includes(element.tag)) {
        events.push(this.event({
          event_type: "action_candidate", screen_id: screenId, state_id: stateId,
          occurred_at: observedAt,
          payload: {
            action: ["input", "textarea", "select"].includes(element.tag) ? "enter_text" : "click",
            target_element_key: elementKey,
            enabled: !element.disabled
          }
        }));
      }
    }
    return events;
  }


  async observeWithEvidence(): Promise<{ events: DiscoveryEvent[]; evidence: CapturedEvidence[] }> {
    const events = await this.observe();
    const screenEvent = events.find((event) => event.event_type === "screen_observed");
    if (!screenEvent) return { events, evidence: [] };

    const [screenshot, snapshots] = await Promise.all([
      this.page.screenshot({ type: "png" }),
      this.page.locator("body").evaluate((body) => {
        const clone = body.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("script").forEach((node) => node.remove());
        clone.querySelectorAll("input").forEach((node) => {
          node.setAttribute("value", "[REDACTED]");
          node.removeAttribute("checked");
        });
        clone.querySelectorAll("textarea").forEach((node) => {
          node.textContent = "[REDACTED]";
        });
        clone.querySelectorAll("[contenteditable='true']").forEach((node) => {
          node.textContent = "[REDACTED]";
        });

        const inferAccessibleRole = (element: HTMLElement): string => {
          const explicit = element.getAttribute("role");
          if (explicit) return explicit;
          const tag = element.tagName.toLowerCase();
          if (tag === "a" && element.hasAttribute("href")) return "link";
          if (tag === "button") return "button";
          if (tag === "textarea") return "textbox";
          if (tag === "select") return "combobox";
          if (tag === "input") {
            const type = (element as HTMLInputElement).type;
            if (type === "checkbox" || type === "radio" || type === "button" || type === "submit") return type === "submit" || type === "button" ? "button" : type;
            return "textbox";
          }
          if (/^h[1-6]$/.test(tag)) return "heading";
          if (tag === "img") return "img";
          return "generic";
        };
        const buildNode = (element: HTMLElement): Record<string, unknown> => {
          const labels = "labels" in element ? Array.from((element as HTMLInputElement).labels ?? []).map((label) => label.innerText.trim()).join(" ") : "";
          const name = element.getAttribute("aria-label") || labels || element.getAttribute("alt") || element.getAttribute("title") || "";
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          return {
            role: inferAccessibleRole(element),
            ...(name ? { name: name.slice(0, 300) } : {}),
            tag: element.tagName.toLowerCase(),
            visible,
            enabled: !("disabled" in element && Boolean((element as HTMLButtonElement).disabled)),
            children: Array.from(element.children).filter((child): child is HTMLElement => child instanceof HTMLElement).map(buildNode)
          };
        };
        return { html: clone.outerHTML, accessibilityTree: buildNode(body as HTMLElement) };
      })
    ]);
    const capturedAt = screenEvent.occurred_at;
    return {
      events,
      evidence: [
        {
          kind: "screenshot",
          content_type: "image/png",
          bytes: screenshot,
          captured_at: capturedAt,
          event_id: screenEvent.event_id
        },
        {
          kind: "dom_snapshot",
          content_type: "text/html; charset=utf-8",
          bytes: Buffer.from(snapshots.html, "utf8"),
          captured_at: capturedAt,
          event_id: screenEvent.event_id
        },
        {
          kind: "accessibility_tree",
          content_type: "application/json",
          bytes: Buffer.from(JSON.stringify(snapshots.accessibilityTree), "utf8"),
          captured_at: capturedAt,
          event_id: screenEvent.event_id
        }
      ]
    };
  }

  private event(input: Omit<DiscoveryEvent, "event_id" | "session_id" | "sequence" | "platform">): DiscoveryEvent {
    return {
      ...input, event_id: randomUUID(), session_id: this.options.sessionId,
      sequence: ++this.sequence, platform: "web"
    };
  }
}
