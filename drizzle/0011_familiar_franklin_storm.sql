CREATE TABLE "join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"community_id" uuid NOT NULL CONSTRAINT "join_requests_community_id_communities_id_fk" REFERENCES "public"."communities"("id") ON DELETE cascade ON UPDATE no action,
	"user_id" uuid NOT NULL CONSTRAINT "join_requests_user_id_users_id_fk" REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	"invitation_id" uuid CONSTRAINT "join_requests_invitation_id_invitations_id_fk" REFERENCES "public"."invitations"("id") ON DELETE set null ON UPDATE no action,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"decided_by" uuid CONSTRAINT "join_requests_decided_by_users_id_fk" REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "communities" ADD COLUMN "welcome_message" varchar(1000) DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "communities" ADD COLUMN "require_approval" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "community_members" ADD COLUMN "rules_accepted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "revoked_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX "join_requests_pending_user_community_unique" ON "join_requests" USING btree ("community_id", "user_id") WHERE "join_requests"."status" = 'pending';
--> statement-breakpoint
CREATE INDEX "join_requests_community_idx" ON "join_requests" USING btree ("community_id");
--> statement-breakpoint
CREATE INDEX "join_requests_status_idx" ON "join_requests" USING btree ("status");
--> statement-breakpoint
ALTER TABLE "join_requests" ENABLE ROW LEVEL SECURITY;
