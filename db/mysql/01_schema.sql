-- 01_schema.sql
-- The DDL submitted in PES2UG24CS597_PES2UG24CS605_DBMS_MiniProject.pdf, unchanged
-- except that CREATE DATABASE / USE are left out: db:reset creates the database
-- and selects it before running this file. All later changes go in 02_alter.sql.

CREATE TABLE role (
    role_id INT AUTO_INCREMENT PRIMARY KEY,
    role_name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE `user` (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    role_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,

    CONSTRAINT fk_user_role
        FOREIGN KEY (role_id)
        REFERENCES role(role_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
);

CREATE TABLE location (
    location_id INT AUTO_INCREMENT PRIMARY KEY,
    grid_id VARCHAR(50) NOT NULL UNIQUE,
    latitude DECIMAL(10,7) NOT NULL,
    longitude DECIMAL(10,7) NOT NULL,

    CONSTRAINT chk_location_latitude
        CHECK (latitude BETWEEN -90 AND 90),

    CONSTRAINT chk_location_longitude
        CHECK (longitude BETWEEN -180 AND 180)
);

CREATE TABLE emergency (
    emergency_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    type VARCHAR(50) NOT NULL,
    start_time DATETIME NOT NULL,
    end_time DATETIME NULL,
    status VARCHAR(30) NOT NULL,
    description TEXT,

    CONSTRAINT chk_emergency_time
        CHECK (end_time IS NULL OR end_time >= start_time)
);

CREATE TABLE emergency_impact (
    impact_id INT AUTO_INCREMENT PRIMARY KEY,
    emergency_id INT NOT NULL,
    location_id INT NOT NULL,
    status VARCHAR(30) NOT NULL,

    CONSTRAINT fk_impact_emergency
        FOREIGN KEY (emergency_id)
        REFERENCES emergency(emergency_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_impact_location
        FOREIGN KEY (location_id)
        REFERENCES location(location_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT uq_emergency_location
        UNIQUE (emergency_id, location_id)
);

CREATE TABLE impact_observation (
    observation_id INT AUTO_INCREMENT PRIMARY KEY,
    impact_id INT NOT NULL,
    user_id INT NOT NULL,
    observed_at DATETIME NOT NULL,
    affected_percentage DECIMAL(5,2) NOT NULL,
    severity VARCHAR(30) NOT NULL,

    CONSTRAINT fk_observation_impact
        FOREIGN KEY (impact_id)
        REFERENCES emergency_impact(impact_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_observation_user
        FOREIGN KEY (user_id)
        REFERENCES `user`(user_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_affected_percentage
        CHECK (affected_percentage BETWEEN 0 AND 100),

    CONSTRAINT uq_impact_observation_time
        UNIQUE (impact_id, observed_at)
);

CREATE TABLE resource (
    resource_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    category VARCHAR(50) NOT NULL,
    unit VARCHAR(30) NOT NULL
);

CREATE TABLE resource_center (
    center_id INT AUTO_INCREMENT PRIMARY KEY,
    location_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    center_type VARCHAR(50) NOT NULL,
    status VARCHAR(30) NOT NULL,

    CONSTRAINT fk_center_location
        FOREIGN KEY (location_id)
        REFERENCES location(location_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
);

CREATE TABLE stock (
    stock_id INT AUTO_INCREMENT PRIMARY KEY,
    resource_id INT NOT NULL,
    center_id INT NOT NULL,
    batch_code VARCHAR(50) NOT NULL,
    quantity_available DECIMAL(12,2) NOT NULL,
    expiry_date DATE NULL,

    CONSTRAINT fk_stock_resource
        FOREIGN KEY (resource_id)
        REFERENCES resource(resource_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_stock_center
        FOREIGN KEY (center_id)
        REFERENCES resource_center(center_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_stock_quantity
        CHECK (quantity_available >= 0),

    CONSTRAINT uq_stock_batch
        UNIQUE (center_id, resource_id, batch_code)
);

CREATE TABLE resource_request (
    request_id INT AUTO_INCREMENT PRIMARY KEY,
    impact_id INT NOT NULL,
    user_id INT NOT NULL,
    requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    required_by DATETIME NULL,
    status VARCHAR(30) NOT NULL,
    description TEXT,

    CONSTRAINT fk_request_impact
        FOREIGN KEY (impact_id)
        REFERENCES emergency_impact(impact_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_request_user
        FOREIGN KEY (user_id)
        REFERENCES `user`(user_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_request_deadline
        CHECK (required_by IS NULL OR required_by >= requested_at)
);

CREATE TABLE request_item (
    request_item_id INT AUTO_INCREMENT PRIMARY KEY,
    request_id INT NOT NULL,
    resource_id INT NOT NULL,
    quantity_requested DECIMAL(12,2) NOT NULL,
    urgency VARCHAR(30) NOT NULL,
    status VARCHAR(30) NOT NULL,

    CONSTRAINT fk_request_item_request
        FOREIGN KEY (request_id)
        REFERENCES resource_request(request_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_request_item_resource
        FOREIGN KEY (resource_id)
        REFERENCES resource(resource_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_requested_quantity
        CHECK (quantity_requested > 0),

    CONSTRAINT uq_request_resource
        UNIQUE (request_id, resource_id)
);

CREATE TABLE allocation (
    allocation_id INT AUTO_INCREMENT PRIMARY KEY,
    request_item_id INT NOT NULL,
    stock_id INT NOT NULL,
    user_id INT NOT NULL,
    quantity_allocated DECIMAL(12,2) NOT NULL,
    allocated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(30) NOT NULL,

    CONSTRAINT fk_allocation_request_item
        FOREIGN KEY (request_item_id)
        REFERENCES request_item(request_item_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_allocation_stock
        FOREIGN KEY (stock_id)
        REFERENCES stock(stock_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_allocation_user
        FOREIGN KEY (user_id)
        REFERENCES `user`(user_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_allocation_quantity
        CHECK (quantity_allocated > 0)
);

CREATE INDEX idx_impact_emergency
    ON emergency_impact(emergency_id);

CREATE INDEX idx_impact_location
    ON emergency_impact(location_id);

CREATE INDEX idx_observation_impact
    ON impact_observation(impact_id);

CREATE INDEX idx_observation_user
    ON impact_observation(user_id);

CREATE INDEX idx_request_impact
    ON resource_request(impact_id);

CREATE INDEX idx_request_user
    ON resource_request(user_id);

CREATE INDEX idx_request_item_request
    ON request_item(request_id);

CREATE INDEX idx_request_item_resource
    ON request_item(resource_id);

CREATE INDEX idx_stock_resource
    ON stock(resource_id);

CREATE INDEX idx_stock_center
    ON stock(center_id);

CREATE INDEX idx_allocation_request_item
    ON allocation(request_item_id);

CREATE INDEX idx_allocation_stock
    ON allocation(stock_id);

CREATE INDEX idx_allocation_user
    ON allocation(user_id);
