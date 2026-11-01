ALTER TABLE "users" ADD COLUMN "banner_url" text;
ALTER TABLE "users" ADD COLUMN "banner_color" varchar(7);
ALTER TABLE "users" ADD COLUMN "status_text" varchar(80) DEFAULT '' NOT NULL;
ALTER TABLE "users" ADD COLUMN "presence_preference" varchar(12) DEFAULT 'online' NOT NULL;
ALTER TABLE "users" ADD COLUMN "show_banner" boolean DEFAULT true NOT NULL;
