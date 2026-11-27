ALTER TABLE products ADD COLUMN purchase_price REAL
  CHECK (purchase_price BETWEEN 0 AND 1.7976931348623157e308);
ALTER TABLE products ADD COLUMN carton_length_cm REAL
  CHECK (carton_length_cm > 0 AND carton_length_cm <= 1.7976931348623157e308);
ALTER TABLE products ADD COLUMN carton_width_cm REAL
  CHECK (carton_width_cm > 0 AND carton_width_cm <= 1.7976931348623157e308);
ALTER TABLE products ADD COLUMN carton_height_cm REAL
  CHECK (carton_height_cm > 0 AND carton_height_cm <= 1.7976931348623157e308);
ALTER TABLE products ADD COLUMN units_per_carton INTEGER
  CHECK (typeof(units_per_carton) = 'integer' AND units_per_carton BETWEEN 1 AND 9007199254740991 OR units_per_carton IS NULL);
ALTER TABLE products ADD COLUMN sea_freight_rate REAL
  CHECK (sea_freight_rate BETWEEN 0 AND 1.7976931348623157e308);
