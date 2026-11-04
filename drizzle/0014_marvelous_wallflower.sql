CREATE TABLE "direct_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_a_id" uuid NOT NULL,
	"user_b_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone,
	CONSTRAINT "direct_conversations_user_order_check" CHECK ("direct_conversations"."user_a_id" < "direct_conversations"."user_b_id")
);
--> statement-breakpoint
CREATE TABLE "direct_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"client_message_id" uuid NOT NULL,
	"body" varchar(2000) NOT NULL,
	"reply_to_id" uuid,
	"builtin_sticker_key" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "direct_reads" (
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "direct_reads_pkey" PRIMARY KEY("user_id","conversation_id")
);
--> statement-breakpoint
CREATE TABLE "dm_blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_blocks_pkey" PRIMARY KEY("blocker_id","blocked_id"),
	CONSTRAINT "dm_blocks_not_self_check" CHECK ("dm_blocks"."blocker_id" <> "dm_blocks"."blocked_id")
);
--> statement-breakpoint
ALTER TABLE "direct_conversations" ADD CONSTRAINT "direct_conversations_user_a_id_users_id_fk" FOREIGN KEY ("user_a_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_conversations" ADD CONSTRAINT "direct_conversations_user_b_id_users_id_fk" FOREIGN KEY ("user_b_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_conversation_id_direct_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."direct_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_messages" ADD CONSTRAINT "direct_messages_reply_to_id_direct_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."direct_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_reads" ADD CONSTRAINT "direct_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "direct_reads" ADD CONSTRAINT "direct_reads_conversation_id_direct_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."direct_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_blocks" ADD CONSTRAINT "dm_blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_blocks" ADD CONSTRAINT "dm_blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "direct_conversations_users_unique" ON "direct_conversations" USING btree ("user_a_id","user_b_id");--> statement-breakpoint
CREATE INDEX "direct_conversations_user_a_idx" ON "direct_conversations" USING btree ("user_a_id");--> statement-breakpoint
CREATE INDEX "direct_conversations_user_b_idx" ON "direct_conversations" USING btree ("user_b_id");--> statement-breakpoint
CREATE UNIQUE INDEX "direct_messages_client_unique" ON "direct_messages" USING btree ("conversation_id","author_id","client_message_id");--> statement-breakpoint
CREATE INDEX "direct_messages_conversation_cursor_idx" ON "direct_messages" USING btree ("conversation_id","created_at","id");--> statement-breakpoint
CREATE INDEX "dm_blocks_blocked_idx" ON "dm_blocks" USING btree ("blocked_id");--> statement-breakpoint
ALTER TABLE "direct_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "direct_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "direct_reads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dm_blocks" ENABLE ROW LEVEL SECURITY;
