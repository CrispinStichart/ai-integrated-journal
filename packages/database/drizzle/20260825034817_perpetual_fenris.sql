CREATE UNIQUE INDEX "search_embedding_cohort_id_owner_unique" ON "journal"."search_embedding_cohort" USING btree ("id","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "search_fragment_id_owner_unique" ON "journal"."search_fragment" USING btree ("id","owner_id");--> statement-breakpoint
ALTER TABLE "journal"."search_embedding_request" ADD CONSTRAINT "search_embedding_request_fragment_owner_fk" FOREIGN KEY ("fragment_id","owner_id") REFERENCES "journal"."search_fragment"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."search_fragment_embedding" ADD CONSTRAINT "search_fragment_embedding_fragment_owner_fk" FOREIGN KEY ("fragment_id","owner_id") REFERENCES "journal"."search_fragment"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."search_fragment_embedding" ADD CONSTRAINT "search_fragment_embedding_cohort_owner_fk" FOREIGN KEY ("cohort_id","owner_id") REFERENCES "journal"."search_embedding_cohort"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE INDEX "search_fragment_embedding_vector_4_hnsw_idx" ON "journal"."search_fragment_embedding" USING hnsw ((embedding::vector(4)) vector_cosine_ops) WHERE vector_dims(embedding) = 4;--> statement-breakpoint
CREATE INDEX "search_fragment_embedding_vector_384_hnsw_idx" ON "journal"."search_fragment_embedding" USING hnsw ((embedding::vector(384)) vector_cosine_ops) WHERE vector_dims(embedding) = 384;--> statement-breakpoint
CREATE INDEX "search_fragment_embedding_vector_768_hnsw_idx" ON "journal"."search_fragment_embedding" USING hnsw ((embedding::vector(768)) vector_cosine_ops) WHERE vector_dims(embedding) = 768;--> statement-breakpoint
CREATE INDEX "search_fragment_embedding_vector_1024_hnsw_idx" ON "journal"."search_fragment_embedding" USING hnsw ((embedding::vector(1024)) vector_cosine_ops) WHERE vector_dims(embedding) = 1024;--> statement-breakpoint
CREATE INDEX "search_fragment_embedding_vector_1536_hnsw_idx" ON "journal"."search_fragment_embedding" USING hnsw ((embedding::vector(1536)) vector_cosine_ops) WHERE vector_dims(embedding) = 1536;--> statement-breakpoint
CREATE INDEX "search_fragment_embedding_vector_3072_hnsw_idx" ON "journal"."search_fragment_embedding" USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops) WHERE vector_dims(embedding) = 3072;--> statement-breakpoint
CREATE FUNCTION "journal"."maintain_search_embedding_request"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "journal"."search_embedding_request" (fragment_id, owner_id)
    VALUES (NEW.id, NEW.owner_id)
    ON CONFLICT (fragment_id) DO NOTHING;
  ELSIF TG_OP = 'UPDATE' AND
        (NEW.content IS DISTINCT FROM OLD.content OR
         NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id OR
         NEW.owner_id IS DISTINCT FROM OLD.owner_id) THEN
    DELETE FROM "journal"."search_fragment_embedding" WHERE fragment_id = NEW.id;
    INSERT INTO "journal"."search_embedding_request" (
      fragment_id, owner_id, generation, status, job_id, cohort_id,
      next_chunk_index, next_character, last_error_code, requested_at,
      updated_at, completed_at
    ) VALUES (
      NEW.id, NEW.owner_id, 1, 'pending', NULL, NULL, 0, 1, NULL, now(), now(), NULL
    ) ON CONFLICT (fragment_id) DO UPDATE SET
      owner_id = EXCLUDED.owner_id,
      generation = "journal"."search_embedding_request".generation + 1,
      status = 'pending', job_id = NULL, cohort_id = NULL,
      next_chunk_index = 0, next_character = 1, last_error_code = NULL,
      requested_at = now(), updated_at = now(), completed_at = NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER search_fragment_embedding_lifecycle
AFTER INSERT OR UPDATE OF content, source_revision_id, owner_id
ON "journal"."search_fragment"
FOR EACH ROW EXECUTE FUNCTION "journal"."maintain_search_embedding_request"();--> statement-breakpoint
INSERT INTO "journal"."search_embedding_request" (fragment_id, owner_id)
SELECT id, owner_id FROM "journal"."search_fragment"
ON CONFLICT (fragment_id) DO NOTHING;
