CREATE TABLE "custom_emojis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"community_id" uuid NOT NULL,
	"name" varchar(32) NOT NULL,
	"storage_key" varchar(255) NOT NULL,
	"mime_type" varchar(120) NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"animated" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "custom_emojis_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "message_stickers" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"sticker_id" uuid,
	"sticker_name" varchar(32) NOT NULL,
	"builtin_key" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "stickers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"community_id" uuid NOT NULL,
	"name" varchar(32) NOT NULL,
	"description" varchar(120) DEFAULT '' NOT NULL,
	"storage_key" varchar(255) NOT NULL,
	"mime_type" varchar(120) NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"animated" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "stickers_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "message_reactions" ALTER COLUMN "emoji" SET DATA TYPE varchar(64);--> statement-breakpoint
ALTER TABLE "custom_emojis" ADD CONSTRAINT "custom_emojis_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_emojis" ADD CONSTRAINT "custom_emojis_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_stickers" ADD CONSTRAINT "message_stickers_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_stickers" ADD CONSTRAINT "message_stickers_sticker_id_stickers_id_fk" FOREIGN KEY ("sticker_id") REFERENCES "public"."stickers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stickers" ADD CONSTRAINT "stickers_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stickers" ADD CONSTRAINT "stickers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_emojis_community_name_active_unique" ON "custom_emojis" USING btree ("community_id","name") WHERE "custom_emojis"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "custom_emojis_community_idx" ON "custom_emojis" USING btree ("community_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stickers_community_name_active_unique" ON "stickers" USING btree ("community_id","name") WHERE "stickers"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "stickers_community_idx" ON "stickers" USING btree ("community_id");--> statement-breakpoint
ALTER TABLE "custom_emojis" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stickers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_stickers" ENABLE ROW LEVEL SECURITY;
