ALTER TABLE "communities" ADD COLUMN IF NOT EXISTS "image_url" text;--> statement-breakpoint
ALTER TABLE "communities" ADD COLUMN IF NOT EXISTS "rules" varchar(4000) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "community_roles" ADD COLUMN IF NOT EXISTS "hierarchy" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "pinned_by" uuid;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_permissions" (
  "channel_id" uuid NOT NULL,
  "role_id" uuid NOT NULL,
  "permission" varchar(50) NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  CONSTRAINT "channel_permissions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade,
  CONSTRAINT "channel_permissions_role_id_community_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."community_roles"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_permissions_unique" ON "channel_permissions" USING btree ("channel_id","role_id","permission");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "community_bans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "community_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "actor_id" uuid NOT NULL,
  "reason" varchar(500) DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "community_bans_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade,
  CONSTRAINT "community_bans_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade,
  CONSTRAINT "community_bans_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "community_bans_lookup_idx" ON "community_bans" USING btree ("community_id","user_id","revoked_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "community_mutes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "community_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "actor_id" uuid NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "reason" varchar(500) DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "community_mutes_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade,
  CONSTRAINT "community_mutes_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade,
  CONSTRAINT "community_mutes_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "community_mutes_lookup_idx" ON "community_mutes" USING btree ("community_id","user_id","expires_at","revoked_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "moderation_audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "community_id" uuid NOT NULL,
  "actor_id" uuid NOT NULL,
  "target_user_id" uuid,
  "action" varchar(60) NOT NULL,
  "reason" varchar(500) DEFAULT '' NOT NULL,
  "duration_seconds" integer,
  "metadata" text DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "moderation_audit_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade,
  CONSTRAINT "moderation_audit_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict,
  CONSTRAINT "moderation_audit_target_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "moderation_audit_community_idx" ON "moderation_audit_logs" USING btree ("community_id","created_at");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE set null;--> statement-breakpoint
