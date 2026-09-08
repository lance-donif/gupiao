-- Cache reuse must be keyed by the full LLM input, not a source-local news ID.
-- Existing rows intentionally remain null: their original input body is not
-- available to reconstruct a safe content fingerprint.
ALTER TABLE "CausalSignalCandidate"
ADD COLUMN "inputFingerprint" TEXT;

CREATE INDEX "CausalSignalCandidate_cluster_inputFingerprint_extractor_model_prompt_idx"
ON "CausalSignalCandidate"("clusterKey", "inputFingerprint", "extractorType", "modelVersion", "promptVersion");
