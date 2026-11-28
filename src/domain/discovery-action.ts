export type DiscoveryActionContext = "native" | "webview";
export type DiscoveryActionType = "tap" | "fill";
export type DiscoveryActionLocatorStrategy = "label" | "test_id" | "role_name";

export interface DiscoveryActionRequest {
  context_type: DiscoveryActionContext;
  action: DiscoveryActionType;
  locator_strategy: DiscoveryActionLocatorStrategy;
  locator_value?: string;
  locator_role?: string;
  locator_name?: string;
  webview_index?: number;
  screen_id?: string;
  state_id?: string;
  target_element_key?: string;
  /** Used only by fill; deliberately omitted from all emitted events and logs. */
  input_value?: string;
}
