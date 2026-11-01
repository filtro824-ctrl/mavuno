CREATE TABLE "message_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid,
	"user_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"storage_key" varchar(255) NOT NULL,
	"original_name" varchar(255) NOT NULL,
	"mime_type" varchar(120) NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_attachments_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null,
	CONSTRAINT "message_attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict,
	CONSTRAINT "message_attachments_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE restrict,
	CONSTRAINT "message_attachments_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict
);
CREATE INDEX "message_attachments_message_idx" ON "message_attachments" USING btree ("message_id");
CREATE INDEX "message_attachments_user_idx" ON "message_attachments" USING btree ("user_id");
ALTER TABLE "message_attachments" ENABLE ROW LEVEL SECURITY;
