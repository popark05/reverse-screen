# Reverse Screen — Architecture Baseline

## Domain model
| Concept | Responsibility |
|---|---|
| Application | Product/system boundary |
| Application Version | Build, release, commit, and environment identity |
| Execution Target | Browser, device, simulator, and runtime configuration |
| Screen | Platform-neutral logical screen |
| Screen Instance | Platform-specific implementation of a logical screen |
| Screen State | Meaningful UI state within a screen |
| Element | Semantic UI element exposed by a screen instance |
| Element Locator | Engine/platform-specific locator strategy and value |
| Action | Reusable semantic action vocabulary |
| Transition | Directed state-to-state behavior |
| Flow / Flow Version | Curated, versioned path or graph |
| Discovery Session | One runtime exploration attempt |
| Discovery Event | Ordered observation/action event |
| Evidence | Screenshot, video, accessibility tree, DOM, hierarchy, log, or trace metadata |

## Critical distinctions
1. **Screen != Screen Instance != Screen State.** A logical Login screen may have Android, iOS, and Web implementations, and states such as Initial, Invalid Credentials, and Loading.
2. **Flow != Test Case.** A Flow describes product behavior. A Test Case defines a verification objective and may cover one or more transitions.
3. **Discovery != Execution.** Discovery explores and proposes graph facts; QA execution runs approved test definitions.
4. **Verified != Approved.** Verified means runtime evidence supports a behavior. Approved means a human accepted an artifact.
5. **Hybrid navigation is explicit.** WebView-to-native handoffs are transitions with platform scope and implementation metadata.
6. **Adapters isolate engines.** Persist semantic actions, locator strategy/value, and normalized results—not Mobilewright or Playwright runtime objects.

## Discovery event lifecycle
A Discovery Session emits ordered Discovery Events. Events may record screen observations, element observations, candidate actions, executed actions, observed transitions, assertions, errors, and session markers. Evidence references are attached by ID; binary evidence is stored outside the relational database.

## Adapter strategy
- Mobile: MobileCLI / Mobilewright adapter.
- Web: Playwright adapter.
- Hybrid: combine WebView observations with native accessibility/platform observations where available.
- DOM/JavaScript inspection is capability-gated and must never be assumed to exist on every build/device.

## Integration boundary
Reverse Screen publishes versioned Application, Screen, Transition, Flow, and Discovery Event contracts. QA Platform consumes these contracts through API or import/export. It must not read or write Reverse Screen's database directly.

## Initial implementation sequence
1. Finalize domain vocabulary and JSON Schema.
2. Implement Discovery Session and Event ingestion.
3. Implement one adapter spike for a web target and one for hybrid Android/iOS.
4. Normalize screen/action/transition observations.
5. Persist evidence metadata and object-storage references.
6. Add graph review and human approval workflow.
7. Publish versioned contracts for QA Platform.

## Non-production caveats
The initial ERD/SQL package is a design draft, not a production migration. Tenant isolation, authorization, audit, retention, and cross-aggregate integrity constraints must be designed before production use.