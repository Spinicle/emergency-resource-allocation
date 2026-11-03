-- 07_seed.sql
-- Demo dataset (docs/HANDOFF.md 4.8): what /allocate, the dashboard, analytics
-- and the important queries run on. All of it is sample data.
--
-- The seed writes data the way the app does:
--   * batches through sp_add_batch, adjustments and write-offs through sp_adjust_stock
--   * allocations only through sp_allocate (autocommit, one item per call),
--     dispatch/deliver as plain UPDATEs of allocation.status, cancels through
--     sp_cancel_allocation
--   * requests and items inserted with their default statuses; the triggers
--     roll statuses up and keep quantity_allocated and the ledger
--
-- Every time is relative to @t0 (the reset time) and every date to @d0 (the
-- reset date), so a reset on demo day gives fresh waits, deadlines and expiry
-- bands. Rows are referenced through variables captured when they're inserted,
-- never through fixed ids. batch_code and grid_id values are unique across the
-- whole seed.
--
-- Logins: every seeded user's password is Eras@2026 (bcryptjs, cost 10).

SET @t0 = NOW();
SET @d0 = CURDATE();

-- ===========================================================================
-- Roles and the users who don't belong to a center
-- ===========================================================================

INSERT INTO role (role_name) VALUES ('ADMIN'), ('COORDINATOR'), ('FIELD_OFFICER'), ('CENTER_MANAGER');
SET @role_admin = (SELECT role_id FROM role WHERE role_name = 'ADMIN');
SET @role_coord = (SELECT role_id FROM role WHERE role_name = 'COORDINATOR');
SET @role_field = (SELECT role_id FROM role WHERE role_name = 'FIELD_OFFICER');
SET @role_cm    = (SELECT role_id FROM role WHERE role_name = 'CENTER_MANAGER');

INSERT INTO `user` (role_id, name, email, password_hash)
VALUES (@role_admin, 'Ananya Iyer', 'admin@eras.test',
        '$2b$10$p31ySy8lc7VLuxEMo0gMsOpLZi2HeAQkIIUCiS39H4rEp1NiFDXju');
SET @u_admin = LAST_INSERT_ID();
INSERT INTO `user` (role_id, name, email, password_hash)
VALUES (@role_coord, 'Rahul Menon', 'coord@eras.test',
        '$2b$10$h4ggXlKnjLT18ZZP/aD4ZOnhYDefnDriWXUOdZ8vBS038rLd1aJde');
SET @u_coord = LAST_INSERT_ID();
-- field1 reports on the Bengaluru flood, field2 on the Kodagu landslide.
INSERT INTO `user` (role_id, name, email, password_hash)
VALUES (@role_field, 'Kiran Kumar', 'field1@eras.test',
        '$2b$10$TRrKaV6VmplvQxtKdYJWIuTEu5ueZ32tt.zr3FO9TSJAYRyS.HYYG');
SET @u_field1 = LAST_INSERT_ID();
INSERT INTO `user` (role_id, name, email, password_hash)
VALUES (@role_field, 'Deepa Poonacha', 'field2@eras.test',
        '$2b$10$lwxc1Wt2B4evHyTtpwnFPOy35IKmRYNkOqU39lo7vCSVaXb.w.U1i');
SET @u_field2 = LAST_INSERT_ID();
-- field3 reported on the Mysuru outbreak and is deactivated at the end of this
-- file (login refused, history kept).
INSERT INTO `user` (role_id, name, email, password_hash)
VALUES (@role_field, 'Ravi Shetty', 'field3@eras.test',
        '$2b$10$ectR7sV14as995/eI9yZkuXMvWR5BMvMElh9C/5/Pb0iDmAAD325.');
SET @u_field3 = LAST_INSERT_ID();

-- ===========================================================================
-- Locations: 10 impact sites and 5 centers (Bengaluru, Kodagu, Mysuru)
-- ===========================================================================

INSERT INTO location (grid_id, latitude, longitude) VALUES ('BLR-BELLANDUR', 12.9260000, 77.6762000);
SET @l_bellandur = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('BLR-MAHADEVAPURA', 12.9889000, 77.6966000);
SET @l_mahadevapura = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('BLR-KORAMANGALA', 12.9352000, 77.6245000);
SET @l_koramangala = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('BLR-YELAHANKA', 13.1007000, 77.5963000);
SET @l_yelahanka = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('KDG-MADIKERI', 12.4244000, 75.7382000);
SET @l_madikeri = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('KDG-MAKKANDUR', 12.4580000, 75.7790000);
SET @l_makkandur = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('KDG-BHAGAMANDALA', 12.3866000, 75.5297000);
SET @l_bhagamandala = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('KDG-NAPOKLU', 12.3053000, 75.7012000);
SET @l_napoklu = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('MYS-NR-MOHALLA', 12.3270000, 76.6620000);
SET @l_nr_mohalla = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('MYS-NANJANGUD', 12.1200000, 76.6800000);
SET @l_nanjangud = LAST_INSERT_ID();

INSERT INTO location (grid_id, latitude, longitude) VALUES ('BLR-PEENYA', 13.0285000, 77.5197000);
SET @l_peenya = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('BLR-WHITEFIELD', 12.9698000, 77.7500000);
SET @l_whitefield = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('KDG-MADIKERI-DEPOT', 12.4210000, 75.7400000);
SET @l_madikeri_depot = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('KDG-KUSHALNAGAR', 12.4575000, 75.9590000);
SET @l_kushalnagar = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('MYS-HOSPITAL', 12.3140000, 76.6510000);
SET @l_mysuru_hospital = LAST_INSERT_ID();

-- ===========================================================================
-- Resources (25). Stretcher and Raincoat are never requested (query 8).
-- ===========================================================================

INSERT INTO resource (name, category, unit) VALUES ('Rice', 'FOOD', 'kg');
SET @r_rice = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Toor dal', 'FOOD', 'kg');
SET @r_dal = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Ready-to-eat meal', 'FOOD', 'packet');
SET @r_rte = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Infant formula', 'FOOD', 'tin');
SET @r_inf = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Drinking water', 'WATER', 'L');
SET @r_wtr = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Water purification tablets', 'WATER', 'strip');
SET @r_pur = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('ORS sachet', 'MEDICAL', 'sachet');
SET @r_ors = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Paracetamol 500 mg', 'MEDICAL', 'strip');
SET @r_pcm = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Amoxicillin 500 mg', 'MEDICAL', 'strip');
SET @r_amx = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('IV fluid RL 500 ml', 'MEDICAL', 'bottle');
SET @r_ivf = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('First aid kit', 'MEDICAL', 'kit');
SET @r_fak = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Dengue NS1 test kit', 'MEDICAL', 'kit');
SET @r_dns = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Tarpaulin sheet', 'SHELTER', 'sheet');
SET @r_tarp = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Family tent', 'SHELTER', 'unit');
SET @r_tent = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Blanket', 'SHELTER', 'piece');
SET @r_blkt = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Hygiene kit', 'HYGIENE', 'kit');
SET @r_hyg = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Bleaching powder', 'HYGIENE', 'kg');
SET @r_blch = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Mosquito net', 'HYGIENE', 'piece');
SET @r_net = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Life jacket', 'RESCUE', 'piece');
SET @r_lj = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Inflatable rescue boat', 'RESCUE', 'unit');
SET @r_boat = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Rope 50 m', 'RESCUE', 'coil');
SET @r_rope = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Stretcher', 'RESCUE', 'unit');
SET @r_str = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Portable generator 5 kVA', 'POWER', 'unit');
SET @r_gen = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Solar lantern', 'POWER', 'piece');
SET @r_lant = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('Raincoat', 'OTHER', 'piece');
SET @r_rain = LAST_INSERT_ID();

-- ===========================================================================
-- Centers. Whitefield starts OPERATIONAL and is closed later in its history;
-- Mysuru District Hospital runs LIMITED (allocations still allowed).
-- ===========================================================================

INSERT INTO resource_center (location_id, name, center_type, status)
VALUES (@l_peenya, 'Bengaluru Central Warehouse', 'WAREHOUSE', 'OPERATIONAL');
SET @c_blr = LAST_INSERT_ID();
INSERT INTO resource_center (location_id, name, center_type, status)
VALUES (@l_whitefield, 'Whitefield Relief Camp', 'RELIEF_CAMP', 'OPERATIONAL');
SET @c_wfd = LAST_INSERT_ID();
INSERT INTO resource_center (location_id, name, center_type, status)
VALUES (@l_madikeri_depot, 'Madikeri Relief Depot', 'DEPOT', 'OPERATIONAL');
SET @c_mdk = LAST_INSERT_ID();
INSERT INTO resource_center (location_id, name, center_type, status)
VALUES (@l_kushalnagar, 'Kushalnagar Relief Camp', 'RELIEF_CAMP', 'OPERATIONAL');
SET @c_ksn = LAST_INSERT_ID();
INSERT INTO resource_center (location_id, name, center_type, status)
VALUES (@l_mysuru_hospital, 'Mysuru District Hospital', 'HOSPITAL', 'LIMITED');
SET @c_mys = LAST_INSERT_ID();

-- Center managers, linked to their centers.
INSERT INTO `user` (role_id, center_id, name, email, password_hash)
VALUES (@role_cm, @c_blr, 'Suresh Gowda', 'cm.central@eras.test',
        '$2b$10$NlUDCfZpF7Pm76.iqpHzWelwKFZ5viaZNrqcgyMQwc5zT8JZzY0Ym');
SET @u_cm_central = LAST_INSERT_ID();
INSERT INTO `user` (role_id, center_id, name, email, password_hash)
VALUES (@role_cm, @c_mdk, 'Meena Appaiah', 'cm.kodagu@eras.test',
        '$2b$10$tDwahaJA6ebJbP5u1ytAt.U1TrHbYssKEaVZaf30QRbMRobFEDffq');
SET @u_cm_kodagu = LAST_INSERT_ID();

-- ===========================================================================
-- Final state
-- ===========================================================================

-- field3 left after the Mysuru outbreak: deactivated, never deleted.
UPDATE `user` SET is_active = FALSE WHERE user_id = @u_field3;
