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
-- Emergencies and impacts. All start ACTIVE; the Mysuru outbreak is closed in
-- the timeline below, after its history is built.
-- ===========================================================================

INSERT INTO emergency (name, type, start_time, status, description)
VALUES ('Bengaluru Urban Flood', 'FLOOD', @t0 - INTERVAL 120 HOUR, 'ACTIVE',
        'Three days of heavy rain overflowed Bellandur and Varthur lakes and the storm drains '
        'of east Bengaluru. Apartment ground floors, underpasses and arterial roads are flooded; '
        'residents are stranded on upper floors and need water, food and evacuation.');
SET @e_flood = LAST_INSERT_ID();
INSERT INTO emergency (name, type, start_time, status, description)
VALUES ('Kodagu Landslide', 'LANDSLIDE', @t0 - INTERVAL 72 HOUR, 'ACTIVE',
        'Landslides after a cloudburst over the Western Ghats cut roads around Madikeri, '
        'Makkandur and Bhagamandala. Houses are damaged, villages are cut off and families '
        'are sheltering in relief camps.');
SET @e_kodagu = LAST_INSERT_ID();
INSERT INTO emergency (name, type, start_time, status, description)
VALUES ('Mysuru Dengue Outbreak', 'EPIDEMIC', @t0 - INTERVAL 40 DAY, 'ACTIVE',
        'Dengue cases rose sharply in Mysuru city and Nanjangud after the monsoon. Health camps '
        'needed test kits, IV fluids, ORS and mosquito nets until case counts fell.');
SET @e_mysuru = LAST_INSERT_ID();

INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_flood, @l_bellandur, 'ACTIVE');
SET @i_bellandur = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_flood, @l_mahadevapura, 'ACTIVE');
SET @i_mahadevapura = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_flood, @l_koramangala, 'ACTIVE');
SET @i_koramangala = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_flood, @l_yelahanka, 'ACTIVE');
SET @i_yelahanka = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_kodagu, @l_madikeri, 'ACTIVE');
SET @i_madikeri = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_kodagu, @l_makkandur, 'ACTIVE');
SET @i_makkandur = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_kodagu, @l_bhagamandala, 'ACTIVE');
SET @i_bhagamandala = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_kodagu, @l_napoklu, 'ACTIVE');
SET @i_napoklu = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_mysuru, @l_nr_mohalla, 'ACTIVE');
SET @i_nr_mohalla = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_mysuru, @l_nanjangud, 'ACTIVE');
SET @i_nanjangud = LAST_INSERT_ID();

-- ===========================================================================
-- Observations (38). The latest one per impact drives the priority score;
-- Bellandur, Mahadevapura, Madikeri and Bhagamandala got worse at their latest
-- observation (query 7). Napoklu has none yet (S = 0.5, A = 0).
-- ===========================================================================

INSERT INTO impact_observation (impact_id, user_id, observed_at, affected_percentage, severity) VALUES
    (@i_bellandur,    @u_field1, @t0 - INTERVAL 118 HOUR, 10, 'LOW'),
    (@i_bellandur,    @u_field1, @t0 - INTERVAL  96 HOUR, 25, 'MODERATE'),
    (@i_bellandur,    @u_field1, @t0 - INTERVAL  72 HOUR, 45, 'HIGH'),
    (@i_bellandur,    @u_field1, @t0 - INTERVAL  48 HOUR, 55, 'HIGH'),
    (@i_bellandur,    @u_field1, @t0 - INTERVAL  20 HOUR, 70, 'CRITICAL'),
    (@i_mahadevapura, @u_field1, @t0 - INTERVAL 110 HOUR, 20, 'MODERATE'),
    (@i_mahadevapura, @u_field1, @t0 - INTERVAL  70 HOUR, 28, 'MODERATE'),
    (@i_mahadevapura, @u_field1, @t0 - INTERVAL  40 HOUR, 30, 'MODERATE'),
    (@i_mahadevapura, @u_field1, @t0 - INTERVAL   6 HOUR, 42, 'HIGH'),
    (@i_koramangala,  @u_field1, @t0 - INTERVAL 115 HOUR, 40, 'HIGH'),
    (@i_koramangala,  @u_field1, @t0 - INTERVAL  90 HOUR, 50, 'HIGH'),
    (@i_koramangala,  @u_field1, @t0 - INTERVAL  60 HOUR, 35, 'MODERATE'),
    (@i_koramangala,  @u_field1, @t0 - INTERVAL  30 HOUR, 25, 'MODERATE'),
    (@i_koramangala,  @u_field1, @t0 - INTERVAL   8 HOUR, 12, 'LOW'),
    (@i_yelahanka,    @u_field1, @t0 - INTERVAL 100 HOUR, 15, 'MODERATE'),
    (@i_yelahanka,    @u_field1, @t0 - INTERVAL  50 HOUR,  6, 'LOW'),
    (@i_yelahanka,    @u_field1, @t0 - INTERVAL  20 HOUR,  2, 'LOW');

INSERT INTO impact_observation (impact_id, user_id, observed_at, affected_percentage, severity) VALUES
    (@i_madikeri,     @u_field2, @t0 - INTERVAL 70 HOUR, 20, 'MODERATE'),
    (@i_madikeri,     @u_field2, @t0 - INTERVAL 60 HOUR, 25, 'MODERATE'),
    (@i_madikeri,     @u_field2, @t0 - INTERVAL 50 HOUR, 35, 'HIGH'),
    (@i_madikeri,     @u_field2, @t0 - INTERVAL 26 HOUR, 40, 'HIGH'),
    (@i_madikeri,     @u_field2, @t0 - INTERVAL  4 HOUR, 55, 'CRITICAL'),
    (@i_makkandur,    @u_field2, @t0 - INTERVAL 68 HOUR, 60, 'HIGH'),
    (@i_makkandur,    @u_field2, @t0 - INTERVAL 55 HOUR, 62, 'HIGH'),
    (@i_makkandur,    @u_field2, @t0 - INTERVAL 40 HOUR, 75, 'CRITICAL'),
    (@i_makkandur,    @u_field2, @t0 - INTERVAL 12 HOUR, 65, 'HIGH'),
    (@i_bhagamandala, @u_field2, @t0 - INTERVAL 60 HOUR, 10, 'LOW'),
    (@i_bhagamandala, @u_field2, @t0 - INTERVAL 30 HOUR, 15, 'LOW'),
    (@i_bhagamandala, @u_field2, @t0 - INTERVAL  9 HOUR, 25, 'MODERATE');

INSERT INTO impact_observation (impact_id, user_id, observed_at, affected_percentage, severity) VALUES
    (@i_nr_mohalla,   @u_field3, @t0 - INTERVAL 38 DAY, 15, 'MODERATE'),
    (@i_nr_mohalla,   @u_field3, @t0 - INTERVAL 33 DAY, 35, 'HIGH'),
    (@i_nr_mohalla,   @u_field3, @t0 - INTERVAL 28 DAY, 40, 'HIGH'),
    (@i_nr_mohalla,   @u_field3, @t0 - INTERVAL 22 DAY, 20, 'MODERATE'),
    (@i_nr_mohalla,   @u_field3, @t0 - INTERVAL 16 DAY,  5, 'LOW'),
    (@i_nanjangud,    @u_field3, @t0 - INTERVAL 36 DAY,  8, 'LOW'),
    (@i_nanjangud,    @u_field3, @t0 - INTERVAL 30 DAY, 18, 'MODERATE'),
    (@i_nanjangud,    @u_field3, @t0 - INTERVAL 24 DAY, 12, 'MODERATE'),
    (@i_nanjangud,    @u_field3, @t0 - INTERVAL 17 DAY,  4, 'LOW');

-- ===========================================================================
-- Requests (16) and items (44), inserted as the app does: status left to its
-- default (OPEN / PENDING) and quantity_allocated left out. The triggers set
-- every later status from the allocations and cancels in the timeline below.
-- Deadlines are spread over overdue, within 6 h, within 24 h, later and none.
-- ===========================================================================

-- ---- Mysuru Dengue Outbreak (closed 14 days ago) --------------------------
INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@i_nr_mohalla, @u_field3, @t0 - INTERVAL 37 DAY, @t0 - INTERVAL 35 DAY,
        'Dengue cases rising in N.R. Mohalla; the urban health centre needs NS1 test kits, '
        'IV fluids and mosquito nets for the fever ward.');
SET @rq1 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq1, @r_dns, 200, 'CRITICAL');
SET @it1_dns = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq1, @r_ivf, 300, 'CRITICAL');
SET @it1_ivf = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq1, @r_net, 500, 'MEDIUM');
SET @it1_net = LAST_INSERT_ID();

-- Only partly served before the emergency closed: its open items stay out of
-- the queue (CLOSED emergency) and show up as unmet demand.
INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@i_nanjangud, @u_field3, @t0 - INTERVAL 30 DAY, @t0 - INTERVAL 27 DAY,
        'Nanjangud PHC fever clinic is overflowing: ORS, paracetamol and bleaching powder '
        'for the wards and the open drains.');
SET @rq2 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq2, @r_ors, 1000, 'HIGH');
SET @it2_ors = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq2, @r_pcm, 800, 'MEDIUM');
SET @it2_pcm = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq2, @r_blch, 200, 'MEDIUM');
SET @it2_blch = LAST_INSERT_ID();

-- ---- Bengaluru Urban Flood --------------------------------------------------
INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@i_bellandur, @u_field1, @t0 - INTERVAL 116 HOUR, @t0 - INTERVAL 110 HOUR,
        'Bellandur lake overflow: families stranded on upper floors of lakeside apartments '
        'need drinking water and ready-to-eat meals.');
SET @rq3 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq3, @r_wtr, 2000, 'CRITICAL');
SET @it3_wtr = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq3, @r_rte, 300, 'HIGH');
SET @it3_rte = LAST_INSERT_ID();

-- Overdue, and life jackets have run out everywhere usable: the top of the queue.
INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@i_bellandur, @u_field1, @t0 - INTERVAL 60 HOUR, @t0 - INTERVAL 2 HOUR,
        'Rescue boats and life jackets to evacuate elderly residents from flooded Bellandur '
        'apartments; ropes for the rescue teams.');
SET @rq4 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq4, @r_lj, 150, 'CRITICAL');
SET @it4_lj = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq4, @r_boat, 4, 'CRITICAL');
SET @it4_boat = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq4, @r_rope, 40, 'HIGH');
SET @it4_rope = LAST_INSERT_ID();

INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@i_mahadevapura, @u_field1, @t0 - INTERVAL 30 HOUR, @t0 + INTERVAL 4 HOUR,
        'Mahadevapura: ground floors flooded; families moved to the community hall need '
        'blankets, ORS, mosquito nets and life jackets.');
SET @rq5 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq5, @r_blkt, 400, 'HIGH');
SET @it5_blkt = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq5, @r_ors, 1000, 'MEDIUM');
SET @it5_ors = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq5, @r_net, 300, 'LOW');
SET @it5_net = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq5, @r_lj, 60, 'HIGH');
SET @it5_lj = LAST_INSERT_ID();

INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@i_koramangala, @u_field1, @t0 - INTERVAL 84 HOUR, @t0 - INTERVAL 60 HOUR,
        'Koramangala 6th Block relief camp: rice, dal and hygiene kits for 300 families.');
SET @rq6 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq6, @r_rice, 500, 'MEDIUM');
SET @it6_rice = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq6, @r_dal, 200, 'MEDIUM');
SET @it6_dal = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq6, @r_hyg, 300, 'MEDIUM');
SET @it6_hyg = LAST_INSERT_ID();

INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@i_koramangala, @u_coord, @t0 - INTERVAL 20 HOUR, @t0 + INTERVAL 20 HOUR,
        'Koramangala camp residents: water purification tablets, paracetamol and ready-to-eat '
        'meals while the community kitchens are shut.');
SET @rq7 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq7, @r_pur, 200, 'MEDIUM');
SET @it7_pur = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq7, @r_pcm, 300, 'LOW');
SET @it7_pcm = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq7, @r_rte, 400, 'HIGH');
SET @it7_rte = LAST_INSERT_ID();

-- On a RESOLVED impact: still in the queue, near the bottom.
INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@i_yelahanka, @u_field1, @t0 - INTERVAL 50 HOUR, NULL,
        'Yelahanka: tarpaulins and solar lanterns for houses with leaking roofs as the water recedes.');
SET @rq8 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq8, @r_tarp, 50, 'LOW');
SET @it8_tarp = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq8, @r_lant, 50, 'LOW');
SET @it8_lant = LAST_INSERT_ID();

-- Cancelled before anything was allocated.
INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@i_bellandur, @u_field1, @t0 - INTERVAL 26 HOUR, @t0 + INTERVAL 10 HOUR,
        'Boats and life jackets for Bellandur (raised again by mistake; duplicate of the '
        'earlier rescue request).');
SET @rq9 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq9, @r_boat, 2, 'HIGH');
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq9, @r_lj, 20, 'HIGH');

INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@i_mahadevapura, @u_coord, @t0 - INTERVAL 3 HOUR, @t0 + INTERVAL 60 HOUR,
        'Generators for the Mahadevapura pumping station and ward clinic; IV fluids and first '
        'aid kits for the clinic.');
SET @rq10 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq10, @r_gen, 4, 'CRITICAL');
SET @it10_gen = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq10, @r_ivf, 100, 'HIGH');
SET @it10_ivf = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq10, @r_fak, 50, 'MEDIUM');
SET @it10_fak = LAST_INSERT_ID();

-- ---- Kodagu Landslide -----------------------------------------------------
INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@i_madikeri, @u_field2, @t0 - INTERVAL 66 HOUR, @t0 - INTERVAL 40 HOUR,
        'Madikeri: landslide-displaced families at the town hall need rice, drinking water '
        'and blankets.');
SET @rq11 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq11, @r_rice, 400, 'HIGH');
SET @it11_rice = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq11, @r_wtr, 3000, 'CRITICAL');
SET @it11_wtr = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq11, @r_blkt, 300, 'HIGH');
SET @it11_blkt = LAST_INSERT_ID();

-- The nearest depot is short on tarpaulins and tents; Kushalnagar covers.
INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@i_madikeri, @u_field2, @t0 - INTERVAL 22 HOUR, @t0 + INTERVAL 5 HOUR,
        'Madikeri: tarpaulins and tents for houses with roofs damaged by falling debris; '
        'generators for the relief camp.');
SET @rq12 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq12, @r_tarp, 300, 'CRITICAL');
SET @it12_tarp = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq12, @r_tent, 30, 'HIGH');
SET @it12_tent = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq12, @r_gen, 5, 'HIGH');
SET @it12_gen = LAST_INSERT_ID();

-- IV fluid: Madikeri has 40, the rest comes from Mysuru's LIMITED hospital.
INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@i_makkandur, @u_field2, @t0 - INTERVAL 40 HOUR, @t0 + INTERVAL 18 HOUR,
        'Makkandur: injured residents at the school shelter need IV fluids, first aid kits and ORS.');
SET @rq13 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq13, @r_ivf, 150, 'CRITICAL');
SET @it13_ivf = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq13, @r_fak, 40, 'HIGH');
SET @it13_fak = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq13, @r_ors, 500, 'MEDIUM');
SET @it13_ors = LAST_INSERT_ID();

INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@i_bhagamandala, @u_field2, @t0 - INTERVAL 10 HOUR, NULL,
        'Bhagamandala: the Kaveri is rising at the Triveni Sangama; ropes, life jackets and '
        'lanterns ahead of an evacuation.');
SET @rq14 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq14, @r_rope, 20, 'MEDIUM');
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq14, @r_lj, 30, 'HIGH');
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq14, @r_lant, 100, 'LOW');

-- Napoklu has no observation yet (S = 0.5, A = 0).
INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@i_napoklu, @u_field2, @t0 - INTERVAL 2 HOUR, @t0 + INTERVAL 30 HOUR,
        'Napoklu: road cut off by a landslide; first supplies of ready-to-eat meals, drinking '
        'water and purification tablets.');
SET @rq15 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq15, @r_rte, 200, 'HIGH');
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq15, @r_wtr, 1000, 'HIGH');
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq15, @r_pur, 100, 'MEDIUM');

-- Cancelled after its allocation was dispatched and called back.
INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@i_makkandur, @u_coord, @t0 - INTERVAL 6 HOUR, @t0 + INTERVAL 12 HOUR,
        'Rice for the Makkandur school shelter (cancelled: the shelter moved to the Madikeri '
        'town hall, which is already supplied).');
SET @rq16 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq16, @r_rice, 200, 'MEDIUM');
SET @it16_rice = LAST_INSERT_ID();

-- ===========================================================================
-- Timeline: stock, allocations and closures in the order they happened
--
-- allocation.allocated_at and stock_ledger.changed_at default to
-- CURRENT_TIMESTAMP, which follows the session clock. Each step sets that clock
-- to its own moment (SET TIMESTAMP) before calling the procedures, so the
-- history carries its real dates; nothing writes those columns directly. Steps
-- run in time order, so the ledger in (changed_at, ledger_id) order is the
-- order the changes were applied. CURDATE() moves with the clock too, which is
-- why every expiry date below uses @d0, and why an allocation's expiry check
-- runs against the date it was made on.
-- ===========================================================================

-- ---- -45 days: opening stock at every center ------------------------------
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 45 DAY);

-- Bengaluru Central Warehouse (received by its manager)
CALL sp_add_batch(@r_rice, @c_blr, 'BLR-RICE-01', 2000,  @d0 + INTERVAL 120 DAY, @u_cm_central, @b_blr_rice_01);
CALL sp_add_batch(@r_dal,  @c_blr, 'BLR-DAL-01',  800,   @d0 + INTERVAL 150 DAY, @u_cm_central, @b_blr_dal_01);
CALL sp_add_batch(@r_rte,  @c_blr, 'BLR-RTE-01',  600,   @d0 + INTERVAL 5 DAY,   @u_cm_central, @b_blr_rte_01);
CALL sp_add_batch(@r_inf,  @c_blr, 'BLR-INF-01',  120,   @d0 - INTERVAL 6 DAY,   @u_cm_central, @b_blr_inf_01);
CALL sp_add_batch(@r_inf,  @c_blr, 'BLR-INF-02',  200,   @d0 + INTERVAL 60 DAY,  @u_cm_central, @b_blr_inf_02);
CALL sp_add_batch(@r_wtr,  @c_blr, 'BLR-WTR-01',  5000,  @d0 + INTERVAL 3 DAY,   @u_cm_central, @b_blr_wtr_01);
CALL sp_add_batch(@r_pur,  @c_blr, 'BLR-PUR-01',  1000,  @d0 + INTERVAL 365 DAY, @u_cm_central, @b_blr_pur_01);
CALL sp_add_batch(@r_ors,  @c_blr, 'BLR-ORS-01',  3000,  @d0 + INTERVAL 2 DAY,   @u_cm_central, @b_blr_ors_01);
CALL sp_add_batch(@r_ors,  @c_blr, 'BLR-ORS-02',  5000,  @d0 + INTERVAL 300 DAY, @u_cm_central, @b_blr_ors_02);
CALL sp_add_batch(@r_pcm,  @c_blr, 'BLR-PCM-01',  2000,  @d0 + INTERVAL 400 DAY, @u_cm_central, @b_blr_pcm_01);
CALL sp_add_batch(@r_amx,  @c_blr, 'BLR-AMX-01',  800,   @d0 + INTERVAL 250 DAY, @u_cm_central, @b_blr_amx_01);
CALL sp_add_batch(@r_ivf,  @c_blr, 'BLR-IVF-01',  400,   @d0 + INTERVAL 180 DAY, @u_cm_central, @b_blr_ivf_01);
CALL sp_add_batch(@r_fak,  @c_blr, 'BLR-FAK-01',  300,   @d0 + INTERVAL 500 DAY, @u_cm_central, @b_blr_fak_01);
CALL sp_add_batch(@r_tarp, @c_blr, 'BLR-TARP-01', 600,   NULL, @u_cm_central, @b_blr_tarp_01);
CALL sp_add_batch(@r_tent, @c_blr, 'BLR-TENT-01', 80,    NULL, @u_cm_central, @b_blr_tent_01);
CALL sp_add_batch(@r_blkt, @c_blr, 'BLR-BLKT-01', 2000,  NULL, @u_cm_central, @b_blr_blkt_01);
CALL sp_add_batch(@r_hyg,  @c_blr, 'BLR-HYG-01',  1000,  NULL, @u_cm_central, @b_blr_hyg_01);
CALL sp_add_batch(@r_blch, @c_blr, 'BLR-BLCH-01', 500,   @d0 - INTERVAL 2 DAY,   @u_cm_central, @b_blr_blch_01);
CALL sp_add_batch(@r_net,  @c_blr, 'BLR-NET-01',  1500,  NULL, @u_cm_central, @b_blr_net_01);
CALL sp_add_batch(@r_lj,   @c_blr, 'BLR-LJ-01',   80,    NULL, @u_cm_central, @b_blr_lj_01);
CALL sp_add_batch(@r_boat, @c_blr, 'BLR-BOAT-01', 6,     NULL, @u_cm_central, @b_blr_boat_01);
CALL sp_add_batch(@r_rope, @c_blr, 'BLR-ROPE-01', 150,   NULL, @u_cm_central, @b_blr_rope_01);
CALL sp_add_batch(@r_str,  @c_blr, 'BLR-STR-01',  60,    NULL, @u_cm_central, @b_blr_str_01);
CALL sp_add_batch(@r_gen,  @c_blr, 'BLR-GEN-01',  3,     NULL, @u_cm_central, @b_blr_gen_01);
CALL sp_add_batch(@r_lant, @c_blr, 'BLR-LANT-01', 800,   NULL, @u_cm_central, @b_blr_lant_01);
CALL sp_add_batch(@r_rain, @c_blr, 'BLR-RAIN-01', 1000,  NULL, @u_cm_central, @b_blr_rain_01);

-- Whitefield Relief Camp (no manager; received by the admin)
CALL sp_add_batch(@r_rte,  @c_wfd, 'WFD-RTE-01',  400,   @d0 + INTERVAL 30 DAY,  @u_admin, @b_wfd_rte_01);
CALL sp_add_batch(@r_wtr,  @c_wfd, 'WFD-WTR-01',  3000,  @d0 + INTERVAL 60 DAY,  @u_admin, @b_wfd_wtr_01);
CALL sp_add_batch(@r_ors,  @c_wfd, 'WFD-ORS-01',  800,   @d0 + INTERVAL 100 DAY, @u_admin, @b_wfd_ors_01);
CALL sp_add_batch(@r_blkt, @c_wfd, 'WFD-BLKT-01', 500,   NULL, @u_admin, @b_wfd_blkt_01);
CALL sp_add_batch(@r_hyg,  @c_wfd, 'WFD-HYG-01',  300,   NULL, @u_admin, @b_wfd_hyg_01);
CALL sp_add_batch(@r_lj,   @c_wfd, 'WFD-LJ-01',   40,    NULL, @u_admin, @b_wfd_lj_01);

-- Madikeri Relief Depot (received by its manager). Short on tarpaulins,
-- tents and IV fluid, which the farther centers cover.
CALL sp_add_batch(@r_rice, @c_mdk, 'MDK-RICE-01', 1000,  @d0 + INTERVAL 90 DAY,  @u_cm_kodagu, @b_mdk_rice_01);
CALL sp_add_batch(@r_dal,  @c_mdk, 'MDK-DAL-01',  400,   @d0 + INTERVAL 120 DAY, @u_cm_kodagu, @b_mdk_dal_01);
CALL sp_add_batch(@r_rte,  @c_mdk, 'MDK-RTE-01',  300,   @d0,                    @u_cm_kodagu, @b_mdk_rte_01);
CALL sp_add_batch(@r_wtr,  @c_mdk, 'MDK-WTR-01',  4000,  @d0 + INTERVAL 6 DAY,   @u_cm_kodagu, @b_mdk_wtr_01);
CALL sp_add_batch(@r_pur,  @c_mdk, 'MDK-PUR-01',  500,   @d0 - INTERVAL 10 DAY,  @u_cm_kodagu, @b_mdk_pur_01);
CALL sp_add_batch(@r_ors,  @c_mdk, 'MDK-ORS-01',  1000,  @d0 + INTERVAL 200 DAY, @u_cm_kodagu, @b_mdk_ors_01);
CALL sp_add_batch(@r_pcm,  @c_mdk, 'MDK-PCM-01',  600,   @d0 + INTERVAL 300 DAY, @u_cm_kodagu, @b_mdk_pcm_01);
CALL sp_add_batch(@r_ivf,  @c_mdk, 'MDK-IVF-01',  40,    @d0 + INTERVAL 150 DAY, @u_cm_kodagu, @b_mdk_ivf_01);
CALL sp_add_batch(@r_fak,  @c_mdk, 'MDK-FAK-01',  100,   @d0 + INTERVAL 400 DAY, @u_cm_kodagu, @b_mdk_fak_01);
CALL sp_add_batch(@r_tarp, @c_mdk, 'MDK-TARP-01', 120,   NULL, @u_cm_kodagu, @b_mdk_tarp_01);
CALL sp_add_batch(@r_tent, @c_mdk, 'MDK-TENT-01', 25,    NULL, @u_cm_kodagu, @b_mdk_tent_01);
CALL sp_add_batch(@r_blkt, @c_mdk, 'MDK-BLKT-01', 600,   NULL, @u_cm_kodagu, @b_mdk_blkt_01);
CALL sp_add_batch(@r_net,  @c_mdk, 'MDK-NET-01',  200,   NULL, @u_cm_kodagu, @b_mdk_net_01);
CALL sp_add_batch(@r_rope, @c_mdk, 'MDK-ROPE-01', 60,    NULL, @u_cm_kodagu, @b_mdk_rope_01);
CALL sp_add_batch(@r_gen,  @c_mdk, 'MDK-GEN-01',  2,     NULL, @u_cm_kodagu, @b_mdk_gen_01);
CALL sp_add_batch(@r_lant, @c_mdk, 'MDK-LANT-01', 300,   NULL, @u_cm_kodagu, @b_mdk_lant_01);

-- Kushalnagar Relief Camp (received by the admin)
CALL sp_add_batch(@r_rice, @c_ksn, 'KSN-RICE-01', 800,   @d0 + INTERVAL 100 DAY, @u_admin, @b_ksn_rice_01);
CALL sp_add_batch(@r_rte,  @c_ksn, 'KSN-RTE-01',  400,   @d0 + INTERVAL 40 DAY,  @u_admin, @b_ksn_rte_01);
CALL sp_add_batch(@r_wtr,  @c_ksn, 'KSN-WTR-01',  5000,  @d0 + INTERVAL 120 DAY, @u_admin, @b_ksn_wtr_01);
CALL sp_add_batch(@r_ors,  @c_ksn, 'KSN-ORS-01',  600,   @d0 + INTERVAL 4 DAY,   @u_admin, @b_ksn_ors_01);
CALL sp_add_batch(@r_tarp, @c_ksn, 'KSN-TARP-01', 400,   NULL, @u_admin, @b_ksn_tarp_01);
CALL sp_add_batch(@r_tent, @c_ksn, 'KSN-TENT-01', 40,    NULL, @u_admin, @b_ksn_tent_01);
CALL sp_add_batch(@r_blkt, @c_ksn, 'KSN-BLKT-01', 800,   NULL, @u_admin, @b_ksn_blkt_01);
CALL sp_add_batch(@r_hyg,  @c_ksn, 'KSN-HYG-01',  400,   NULL, @u_admin, @b_ksn_hyg_01);
CALL sp_add_batch(@r_net,  @c_ksn, 'KSN-NET-01',  300,   NULL, @u_admin, @b_ksn_net_01);
CALL sp_add_batch(@r_gen,  @c_ksn, 'KSN-GEN-01',  1,     NULL, @u_admin, @b_ksn_gen_01);
CALL sp_add_batch(@r_lant, @c_ksn, 'KSN-LANT-01', 200,   NULL, @u_admin, @b_ksn_lant_01);

-- Mysuru District Hospital (received by the admin)
CALL sp_add_batch(@r_ors,  @c_mys, 'MYS-ORS-01',  2000,  @d0 + INTERVAL 150 DAY, @u_admin, @b_mys_ors_01);
CALL sp_add_batch(@r_pcm,  @c_mys, 'MYS-PCM-01',  3000,  @d0 + INTERVAL 200 DAY, @u_admin, @b_mys_pcm_01);
CALL sp_add_batch(@r_pcm,  @c_mys, 'MYS-PCM-02',  500,   @d0 - INTERVAL 20 DAY,  @u_admin, @b_mys_pcm_02);
CALL sp_add_batch(@r_amx,  @c_mys, 'MYS-AMX-01',  1500,  @d0 + INTERVAL 180 DAY, @u_admin, @b_mys_amx_01);
CALL sp_add_batch(@r_ivf,  @c_mys, 'MYS-IVF-01',  600,   @d0 + INTERVAL 7 DAY,   @u_admin, @b_mys_ivf_01);
CALL sp_add_batch(@r_ivf,  @c_mys, 'MYS-IVF-02',  800,   @d0 + INTERVAL 240 DAY, @u_admin, @b_mys_ivf_02);
CALL sp_add_batch(@r_fak,  @c_mys, 'MYS-FAK-01',  150,   @d0 + INTERVAL 300 DAY, @u_admin, @b_mys_fak_01);
CALL sp_add_batch(@r_dns,  @c_mys, 'MYS-DNS-01',  400,   @d0 - INTERVAL 4 DAY,   @u_admin, @b_mys_dns_01);
CALL sp_add_batch(@r_dns,  @c_mys, 'MYS-DNS-02',  300,   @d0 + INTERVAL 120 DAY, @u_admin, @b_mys_dns_02);
CALL sp_add_batch(@r_net,  @c_mys, 'MYS-NET-01',  1200,  NULL, @u_admin, @b_mys_net_01);
CALL sp_add_batch(@r_blch, @c_mys, 'MYS-BLCH-01', 300,   @d0 + INTERVAL 90 DAY,  @u_admin, @b_mys_blch_01);
CALL sp_add_batch(@r_inf,  @c_mys, 'MYS-INF-01',  100,   @d0 + INTERVAL 30 DAY,  @u_admin, @b_mys_inf_01);
CALL sp_add_batch(@r_wtr,  @c_mys, 'MYS-WTR-01',  2000,  @d0 + INTERVAL 90 DAY,  @u_admin, @b_mys_wtr_01);
CALL sp_add_batch(@r_str,  @c_mys, 'MYS-STR-01',  20,    NULL, @u_admin, @b_mys_str_01);

-- Allocations below are made by the coordinator, one item per CALL, each from
-- the batch sp_suggest_batches ranks first at that moment (nearest open center,
-- then earliest expiry). Dispatch and deliver are plain status UPDATEs.

-- ---- -36 days: Mysuru outbreak, N.R. Mohalla served in full ---------------
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 36 DAY);
-- DNS-01 and IVF-01 expire first (DNS-01 has expired since).
CALL sp_allocate(@it1_dns, @b_mys_dns_01, 200, @u_coord, @a1_dns);
CALL sp_allocate(@it1_ivf, @b_mys_ivf_01, 300, @u_coord, @a1_ivf);
CALL sp_allocate(@it1_net, @b_mys_net_01, 500, @u_coord, @a1_net);
UPDATE allocation SET status = 'DISPATCHED' WHERE allocation_id IN (@a1_dns, @a1_ivf, @a1_net);
UPDATE allocation SET status = 'DELIVERED'  WHERE allocation_id IN (@a1_dns, @a1_ivf, @a1_net);

-- ---- -29 days: Nanjangud served in part -----------------------------------
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 29 DAY);
-- PCM-02 still had 9 days left and expires before PCM-01, so it goes first.
CALL sp_allocate(@it2_ors, @b_mys_ors_01, 1000, @u_coord, @a2_ors);
CALL sp_allocate(@it2_pcm, @b_mys_pcm_02, 400,  @u_coord, @a2_pcm);
UPDATE allocation SET status = 'DISPATCHED' WHERE allocation_id IN (@a2_ors, @a2_pcm);
UPDATE allocation SET status = 'DELIVERED'  WHERE allocation_id IN (@a2_ors, @a2_pcm);

-- ---- -14 days: the Mysuru outbreak is over --------------------------------
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 14 DAY);
UPDATE emergency_impact SET status = 'RESOLVED' WHERE impact_id IN (@i_nr_mohalla, @i_nanjangud);
UPDATE emergency SET status = 'CLOSED', end_time = @t0 - INTERVAL 14 DAY WHERE emergency_id = @e_mysuru;

-- ---- -115 hours: first flood relief from the Whitefield camp, nearest to Bellandur
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 115 HOUR);
CALL sp_allocate(@it3_wtr, @b_wfd_wtr_01, 2000, @u_coord, @a3_wtr);
CALL sp_allocate(@it3_rte, @b_wfd_rte_01, 300,  @u_coord, @a3_rte);
UPDATE allocation SET status = 'DISPATCHED' WHERE allocation_id IN (@a3_wtr, @a3_rte);
UPDATE allocation SET status = 'DELIVERED'  WHERE allocation_id IN (@a3_wtr, @a3_rte);

-- ---- -97 hours: flood water reaches the Whitefield camp's store -----------
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 97 HOUR);
CALL sp_adjust_stock(@b_wfd_rte_01, -50, 'WRITE_OFF', @u_admin);

-- ---- -96 hours: Whitefield camp flooded out and closed; its remaining stock
-- stays on the books but can't be allocated. Top-up at the Central Warehouse.
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 96 HOUR);
UPDATE resource_center SET status = 'CLOSED' WHERE center_id = @c_wfd;
CALL sp_add_batch(@r_rice, @c_blr, 'BLR-RICE-02', 1500,  @d0 + INTERVAL 200 DAY, @u_cm_central, @b_blr_rice_02);
CALL sp_add_batch(@r_rte,  @c_blr, 'BLR-RTE-02',  1500,  @d0 + INTERVAL 90 DAY,  @u_cm_central, @b_blr_rte_02);
CALL sp_add_batch(@r_wtr,  @c_blr, 'BLR-WTR-02',  20000, @d0 + INTERVAL 180 DAY, @u_cm_central, @b_blr_wtr_02);
CALL sp_add_batch(@r_blkt, @c_blr, 'BLR-BLKT-02', 1000,  NULL, @u_cm_central, @b_blr_blkt_02);

-- ---- -90 hours: stock count finds 25 kg of rice short ---------------------
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 90 HOUR);
CALL sp_adjust_stock(@b_blr_rice_01, -25, 'ADJUSTMENT', @u_cm_central);

-- ---- -80 hours: Koramangala camp served from the Central Warehouse --------
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 80 HOUR);
-- RICE-01 expires before RICE-02.
CALL sp_allocate(@it6_rice, @b_blr_rice_01, 500, @u_coord, @a6_rice);
CALL sp_allocate(@it6_dal,  @b_blr_dal_01,  200, @u_coord, @a6_dal);
CALL sp_allocate(@it6_hyg,  @b_blr_hyg_01,  300, @u_coord, @a6_hyg);
UPDATE allocation SET status = 'DISPATCHED' WHERE allocation_id IN (@a6_rice, @a6_dal, @a6_hyg);
UPDATE allocation SET status = 'DELIVERED'  WHERE allocation_id IN (@a6_rice, @a6_dal, @a6_hyg);

-- ---- -64 hours: Madikeri town hall served from the Madikeri depot ---------
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 64 HOUR);
-- WTR-01 is the only water there yet (WTR-02 arrives at -48 h) and expires first anyway.
CALL sp_allocate(@it11_rice, @b_mdk_rice_01, 400,  @u_coord, @a11_rice);
CALL sp_allocate(@it11_wtr,  @b_mdk_wtr_01,  3000, @u_coord, @a11_wtr);
CALL sp_allocate(@it11_blkt, @b_mdk_blkt_01, 300,  @u_coord, @a11_blkt);
UPDATE allocation SET status = 'DISPATCHED' WHERE allocation_id IN (@a11_rice, @a11_wtr, @a11_blkt);
UPDATE allocation SET status = 'DELIVERED'  WHERE allocation_id IN (@a11_rice, @a11_wtr, @a11_blkt);

-- ---- -55 hours: Bellandur rescue kit. Every usable life jacket goes; the
-- jackets are still on the way, the boats and ropes have arrived.
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 55 HOUR);
CALL sp_allocate(@it4_lj,   @b_blr_lj_01,   80, @u_coord, @a4_lj);
CALL sp_allocate(@it4_boat, @b_blr_boat_01, 4,  @u_coord, @a4_boat);
CALL sp_allocate(@it4_rope, @b_blr_rope_01, 40, @u_coord, @a4_rope);
UPDATE allocation SET status = 'DISPATCHED' WHERE allocation_id IN (@a4_lj, @a4_boat, @a4_rope);
UPDATE allocation SET status = 'DELIVERED'  WHERE allocation_id IN (@a4_boat, @a4_rope);

-- ---- -48 hours: landslide top-up in Kodagu --------------------------------
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 48 HOUR);
CALL sp_add_batch(@r_rte,  @c_mdk, 'MDK-RTE-02',  500,   @d0 + INTERVAL 75 DAY,  @u_cm_kodagu, @b_mdk_rte_02);
CALL sp_add_batch(@r_wtr,  @c_mdk, 'MDK-WTR-02',  6000,  @d0 + INTERVAL 150 DAY, @u_cm_kodagu, @b_mdk_wtr_02);
CALL sp_add_batch(@r_pur,  @c_ksn, 'KSN-PUR-01',  300,   @d0 + INTERVAL 200 DAY, @u_admin,     @b_ksn_pur_01);

-- ---- -38 hours: Makkandur. Madikeri's 40 bottles of IV fluid aren't enough;
-- the rest comes from the LIMITED Mysuru hospital, earliest expiry first.
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 38 HOUR);
CALL sp_allocate(@it13_ivf, @b_mdk_ivf_01, 40,  @u_coord, @a13_ivf_mdk);
CALL sp_allocate(@it13_ivf, @b_mys_ivf_01, 110, @u_coord, @a13_ivf_mys);
CALL sp_allocate(@it13_fak, @b_mdk_fak_01, 40,  @u_coord, @a13_fak);
UPDATE allocation SET status = 'DISPATCHED' WHERE allocation_id IN (@a13_ivf_mdk, @a13_ivf_mys, @a13_fak);
UPDATE allocation SET status = 'DELIVERED'  WHERE allocation_id IN (@a13_ivf_mdk, @a13_fak);

-- ---- -30 hours: recount finds 20 more blankets at Madikeri ----------------
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 30 HOUR);
CALL sp_adjust_stock(@b_mdk_blkt_01, 20, 'ADJUSTMENT', @u_cm_kodagu);

-- ---- -28 hours: Mahadevapura, reserved. ORS from the batch expiring in 2 days.
-- No life jackets left anywhere usable.
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 28 HOUR);
CALL sp_allocate(@it5_blkt, @b_blr_blkt_01, 400,  @u_coord, @a5_blkt);
CALL sp_allocate(@it5_ors,  @b_blr_ors_01,  1000, @u_coord, @a5_ors);

-- ---- -24 hours: expired infant formula written off (40 tins await disposal);
-- the duplicate Bellandur request is cancelled (nothing was allocated to it).
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 24 HOUR);
CALL sp_adjust_stock(@b_blr_inf_01, -80, 'WRITE_OFF', @u_cm_central);
-- Request cancel as in HANDOFF 4.4: lock the items, cancel them, the request follows.
START TRANSACTION;
SELECT COUNT(*) INTO @locked FROM request_item WHERE request_id = @rq9 FOR UPDATE;
UPDATE request_item SET status = 'CANCELLED' WHERE request_id = @rq9;
COMMIT;

-- ---- -20 hours: Madikeri roofs. The depot's 120 tarpaulins, then Kushalnagar;
-- all 25 of the depot's tents. No generator reserved yet.
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 20 HOUR);
CALL sp_allocate(@it12_tarp, @b_mdk_tarp_01, 120, @u_coord, @a12_tarp_mdk);
CALL sp_allocate(@it12_tarp, @b_ksn_tarp_01, 180, @u_coord, @a12_tarp_ksn);
CALL sp_allocate(@it12_tent, @b_mdk_tent_01, 25,  @u_coord, @a12_tent);

-- ---- -18 / -16 hours: purification tablets reserved for Koramangala, then
-- released (the camp got a water tanker instead). The item is PENDING again.
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 18 HOUR);
CALL sp_allocate(@it7_pur, @b_blr_pur_01, 200, @u_coord, @a7_pur);
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 16 HOUR);
CALL sp_cancel_allocation(@a7_pur, @u_coord);

-- ---- -12 hours: expired bleaching powder written off in full --------------
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 12 HOUR);
CALL sp_adjust_stock(@b_blr_blch_01, -500, 'WRITE_OFF', @u_cm_central);

-- ---- -5 / -4 hours: rice for Makkandur dispatched, called back when the
-- shelter moved, and the request cancelled.
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 5 HOUR);
CALL sp_allocate(@it16_rice, @b_mdk_rice_01, 200, @u_coord, @a16_rice);
UPDATE allocation SET status = 'DISPATCHED' WHERE allocation_id = @a16_rice;
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 4 HOUR);
CALL sp_cancel_allocation(@a16_rice, @u_coord);
START TRANSACTION;
SELECT COUNT(*) INTO @locked FROM request_item WHERE request_id = @rq16 FOR UPDATE;
UPDATE request_item SET status = 'CANCELLED' WHERE request_id = @rq16;
COMMIT;

-- ---- -2 hours: Mahadevapura pumping station. The Central Warehouse's last 3
-- generators are reserved; IV fluid is on its way.
SET TIMESTAMP = UNIX_TIMESTAMP(@t0 - INTERVAL 2 HOUR);
CALL sp_allocate(@it10_gen, @b_blr_gen_01, 3,   @u_coord, @a10_gen);
CALL sp_allocate(@it10_ivf, @b_blr_ivf_01, 100, @u_coord, @a10_ivf);
UPDATE allocation SET status = 'DISPATCHED' WHERE allocation_id = @a10_ivf;

-- ===========================================================================
-- Final state
-- ===========================================================================

SET TIMESTAMP = DEFAULT;

-- Koramangala's water is receding; Yelahanka is clear (its last request stays open).
UPDATE emergency_impact SET status = 'STABILISED' WHERE impact_id = @i_koramangala;
UPDATE emergency_impact SET status = 'RESOLVED'   WHERE impact_id = @i_yelahanka;

-- field3 left after the Mysuru outbreak: deactivated, never deleted.
UPDATE `user` SET is_active = FALSE WHERE user_id = @u_field3;
