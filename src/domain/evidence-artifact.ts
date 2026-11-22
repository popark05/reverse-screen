import { randomUUID } from "node:crypto";

export const EVIDENCE_KINDS = ["screenshot", "video", "dom_snapshot", "accessibility_tree", "log", "network_trace"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface EvidenceArtifact {
  evidence_id: string;
  session_id: string;
  event_id?: string;
  kind: EvidenceKind;
  content_type: string;
  byte_size: number;
  sha256: string;
  storage_uri: string;
  captured_at: string;
  created_at: string;
}
export type CreateEvidenceArtifactInput = Omit<EvidenceArtifact, "evidence_id" | "created_at">;
export interface EvidenceArtifactStore {
  create(input: CreateEvidenceArtifactInput): Promise<EvidenceArtifact>;
  get(evidenceId: string): Promise<EvidenceArtifact | undefined>;
  listBySession(sessionId: string): Promise<EvidenceArtifact[]>;
}

export class InMemoryEvidenceArtifactStore implements EvidenceArtifactStore {
  private readonly artifacts = new Map<string, EvidenceArtifact>();
  async create(input: CreateEvidenceArtifactInput): Promise<EvidenceArtifact> {
    const artifact: EvidenceArtifact = { ...input, evidence_id: randomUUID(), created_at: new Date().toISOString() };
    this.artifacts.set(artifact.evidence_id, artifact);
    return artifact;
  }
  async get(evidenceId: string): Promise<EvidenceArtifact | undefined> { return this.artifacts.get(evidenceId); }
  async listBySession(sessionId: string): Promise<EvidenceArtifact[]> {
    return [...this.artifacts.values()].filter((item) => item.session_id === sessionId);
  }
}
