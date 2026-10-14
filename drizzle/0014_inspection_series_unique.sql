-- 0014_inspection_series_unique: 点検の系列は対象ごとに一つ（docs/04「対象一つ」をDBで担保）。
-- 0013までは UNIQUE (unit_id, id) だけで、並行の初回点検で同対象に2系列が作り得た。
-- 部分一意索引で「対象が設定されている行」だけを一意にする。二重作成は409 DUPLICATE（build.tsのduplicateOn）。

CREATE UNIQUE INDEX uq_series_facility ON inspection_series (facility_id) WHERE facility_id IS NOT NULL;
CREATE UNIQUE INDEX uq_series_vehicle ON inspection_series (vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE UNIQUE INDEX uq_series_equipment ON inspection_series (equipment_id) WHERE equipment_id IS NOT NULL;
