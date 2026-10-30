UPDATE "community_roles" SET "hierarchy" = CASE "key" WHEN 'owner' THEN 100 WHEN 'admin' THEN 80 WHEN 'moderator' THEN 50 ELSE 10 END;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r.id, p.permission
FROM "community_roles" r
CROSS JOIN (VALUES
  ('manage_members'), ('manage_roles'), ('manage_channel_permissions'), ('pin_messages'), ('ban_members'), ('mute_members'), ('view_audit_log')
) AS p(permission)
WHERE r.key IN ('owner', 'admin')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r.id, p.permission
FROM "community_roles" r
CROSS JOIN (VALUES ('pin_messages'), ('ban_members'), ('mute_members'), ('view_audit_log')) AS p(permission)
WHERE r.key = 'moderator'
ON CONFLICT DO NOTHING;
