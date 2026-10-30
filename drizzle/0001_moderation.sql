ALTER TABLE "role_permissions" ALTER COLUMN "permission" TYPE varchar(50) USING "permission"::text;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."permission_key";
