# Reverse Screen

Reverse Screen discovers an application's runtime screen structure and behavior by exploring a running web or mobile application and converting observations into a normalized application model.

The initial target is **hybrid mobile**: Android and iOS containers with WebView-based screens and native handoffs such as camera, login, payment, push notifications, and permissions. Web applications are also in scope.

## Product responsibilities
- Discover logical screens, platform-specific screen instances, and meaningful screen states.
- Observe semantic elements, candidate actions, and state transitions.
- Capture ordered discovery events and supporting evidence.
- Build reviewable flow graphs from runtime observations.
- Preserve provenance: observed, inferred, verified, and human-approved facts remain distinguishable.

## Tooling direction
The runtime integration is adapter-based. Initial candidates are [MobileCLI](https://github.com/mobile-next/mobilecli) and [Mobilewright](https://github.com/mobile-next/mobilewright) for mobile exploration, plus Playwright for web. Adapter-specific objects must not leak into the domain model.

DOM/WebView inspection is optional, not a prerequisite. The discovery model must also work with accessibility and platform-level observations.

## Repository boundaries
- Wireflow Review owns planning-time flow review.
- Reverse Screen owns runtime discovery and the application/flow model.
- [QA Platform](https://github.com/popark05/qa-platform) owns test authoring, execution, and result reporting.
- Cross-repository integration uses versioned JSON Schema/OpenAPI contracts, never direct writes to another product's database.

## Current status
Architecture baseline is being established. No production database or runtime adapter is configured yet.

## Design principles
1. Screen, Screen Instance, and Screen State are separate concepts.
2. A Flow is not a Test Case.
3. Discovery is not Test Execution.
4. Runtime verification and human approval are separate statuses.
5. Evidence binaries belong in object storage; metadata belongs in the application data store.

## License
To be decided before public distribution.