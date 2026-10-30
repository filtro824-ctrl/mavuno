CREATE TABLE IF NOT EXISTS "private_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "caller_id" uuid NOT NULL,
  "callee_id" uuid NOT NULL,
  "status" varchar(20) DEFAULT 'initiated' NOT NULL,
  "livekit_room" varchar(140) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "answered_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  CONSTRAINT "private_calls_caller_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."users"("id") ON DELETE cascade,
  CONSTRAINT "private_calls_callee_id_fk" FOREIGN KEY ("callee_id") REFERENCES "public"."users"("id") ON DELETE cascade,
  CONSTRAINT "private_calls_livekit_room_unique" UNIQUE("livekit_room")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "private_calls_participants_idx" ON "private_calls" USING btree ("caller_id","callee_id","created_at");
