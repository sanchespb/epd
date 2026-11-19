from __future__ import annotations

import base64
import json
import os
import re
import sys
from datetime import date, datetime, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from data_sources import Catalogs, clean, normalize_name, read_counteragents, read_xlsx, value, vehicle_ownership_kind
from server_generator import Generator
from manual_corrections import prepare_manual_fields
from container_types import body_type_from_ttn, container_iso_from_ttn, transport_mode_from_ttn


def load_catalogs():
    catalogs = Catalogs()
    files = {
        "companies": Path(os.getenv("AGR_COMPANIES_FILE", r"C:\Users\alekseev\Downloads\2026-07-31_060611_LIST_COMPANY.xlsx")),
        "edo": Path(os.getenv("AGR_EDO_FILE", r"C:\Users\alekseev\Downloads\counteragents.csv")),
        "vehicles": Path(os.getenv("AGR_VEHICLES_FILE", r"G:\Common\SCI\AB Cargo\Справочники logos\Справочник автомашины.xlsx")),
        "drivers": Path(os.getenv("AGR_DRIVERS_FILE", r"G:\Common\SCI\AB Cargo\Справочники logos\Справочник водители.xlsx")),
        "points": Path(os.getenv("AGR_POINTS_FILE", r"G:\Common\SCI\AB Cargo\Справочники logos\Справочник Точки маршрута.xlsx")),
    }
    def read_catalog(path, sheet):
        json_path = path.with_suffix(".json")
        if json_path.exists():
            with json_path.open(encoding="utf-8") as stream:
                return json.load(stream)
        return read_xlsx(path, sheet)
    if files["companies"].exists(): catalogs.companies = read_catalog(files["companies"], "LIST_COMPANY")
    if files["edo"].exists(): catalogs.edo = read_counteragents(files["edo"])
    if files["vehicles"].exists(): catalogs.vehicles = read_catalog(files["vehicles"], "LIST_AUTO")
    if files["drivers"].exists(): catalogs.drivers = read_catalog(files["drivers"], "LIST_DRIVERS")
    if files["points"].exists(): catalogs.points = read_catalog(files["points"], "LIST_WAREHOUSE")
    return catalogs


catalogs = load_catalogs()
generator = Generator(ROOT / "resources", catalogs)
cache_dir = ROOT.parent / "web_app" / "work" / "source-cache"
source_stamp = None
catalog_stamp = None
cargo_rows, cargo_index, auto_index = [], {}, {}
cargo_records, auto_records = {}, {}
auto_by_id, auto_by_unit = {}, {}


def current_catalog_stamp():
    configured = (
        os.getenv("AGR_COMPANIES_FILE", ""),
        os.getenv("AGR_EDO_FILE", ""),
        os.getenv("AGR_VEHICLES_FILE", ""),
        os.getenv("AGR_DRIVERS_FILE", ""),
        os.getenv("AGR_POINTS_FILE", ""),
        os.getenv("AGR_CONTRACTS_FILE", ""),
    )
    paths = []
    for value in configured:
        if not value:
            continue
        path = Path(value)
        json_path = path.with_suffix(".json")
        paths.append(json_path if json_path.exists() else path)
    return tuple((str(path), path.stat().st_mtime_ns if path.exists() else 0) for path in paths)


def refresh_catalogs():
    global catalogs, generator, catalog_stamp
    stamp = current_catalog_stamp()
    if stamp == catalog_stamp:
        return
    catalogs = load_catalogs()
    generator = Generator(ROOT / "resources", catalogs)
    catalog_stamp = stamp


def refresh_sources():
    global source_stamp, cargo_rows, cargo_index, auto_index, cargo_records, auto_records, auto_by_id, auto_by_unit
    cargo_file, auto_file = cache_dir / "cargo.xlsx", cache_dir / "auto.xlsx"
    cargo_json, auto_json = cargo_file.with_suffix(".json"), auto_file.with_suffix(".json")
    cargo_source = cargo_json if cargo_json.exists() else cargo_file
    auto_source = auto_json if auto_json.exists() else auto_file
    stamp = (cargo_source.stat().st_mtime_ns, auto_source.stat().st_mtime_ns)
    if stamp == source_stamp: return
    def read_source(path, xlsx_path, sheet):
        if path.suffix == ".json":
            with path.open(encoding="utf-8") as stream:
                return json.load(stream)
        return read_xlsx(xlsx_path, sheet)
    cargo_rows = read_source(cargo_source, cargo_file, "OPERATION_UNIT")
    cargo_index, cargo_records = {}, {}
    for row in cargo_rows:
        for cell in row.values():
            text = clean(cell)
            if len(text) >= 11:
                import re
                match = re.search(r"[A-ZА-Я]{4}\d{7}", text.upper())
                if match:
                    cargo_records.setdefault(match.group(), []).append(row)
                    cargo_index[match.group()] = row
                    break
    auto_index, auto_records, auto_by_id, auto_by_unit = {}, {}, {}, {}
    supplemental_fields = (
        "Водитель", "ФИО водителя", "Телефон водителя",
        "Номер автомашины", "Транспортное средство", "Номер прицепа", "Грузополучатель",
    )
    def operation_score(row, expected_carrier=""):
        return sum((
            100 if expected_carrier and normalize_name(value(row, "Исполнитель", "Перевозчик")) == normalize_name(expected_carrier) else 0,
            8 if clean(value(row, "Водитель", "ФИО водителя")) else 0,
            8 if clean(value(row, "Номер автомашины", "Транспортное средство")) else 0,
            4 if clean(value(row, "Маршрут")) else 0,
            4 if clean(value(row, "Исполнитель", "Перевозчик")) else 0,
            2 if clean(value(row, "Плановая дата отправления")) else 0,
            2 if clean(value(row, "Плановая дата прибытия")) else 0,
        ))
    for row in read_source(auto_source, auto_file, "OPERATION_SUB_DOC"):
        import re
        record_id = clean(row.get("Номер записи"))
        if record_id:
            auto_by_id[record_id] = dict(row)
        raw_unit = clean(row.get("Номера грузовых единиц"))
        if raw_unit:
            auto_by_unit.setdefault(raw_unit.casefold(), []).append(dict(row))
        containers = list(dict.fromkeys(re.findall(r"[A-ZА-Я]{4}\d{7}", clean(row.get("Номера грузовых единиц")).upper())))
        if not containers:
            continue
        for container in containers:
            auto_records.setdefault(container, []).append(dict(row))
            if container not in auto_index:
                auto_index[container] = dict(row)
                continue
            selected = auto_index[container]
            candidate = row
            expected_carrier = clean(value(cargo_index.get(container) or {}, "Перевозчик", "Исполнитель"))
            if operation_score(candidate, expected_carrier) > operation_score(selected, expected_carrier):
                selected, candidate = dict(candidate), selected
                auto_index[container] = selected
            if normalize_name(value(selected, "Исполнитель", "Перевозчик")) == normalize_name(value(candidate, "Исполнитель", "Перевозчик")):
                for field in supplemental_fields:
                    if not clean(selected.get(field)) and clean(candidate.get(field)):
                        selected[field] = candidate[field]
    source_stamp = stamp


def records_for(container):
    if container in auto_by_id:
        row = auto_by_id[container]
        yield container, None, row
        return
    if container.casefold() in auto_by_unit and not re.fullmatch(r"[A-ZА-Я]{4}\d{7}", container, re.I):
        rows = auto_by_unit[container.casefold()]
        for row in rows:
            yield clean(row.get("Номер записи")) or container, None, row
        return
    autos = auto_records.get(container) or ([auto_index[container]] if container in auto_index else [])
    selected = auto_index.get(container)
    ordered = ([selected] if selected else []) + [row for row in autos if str(row.get("Номер записи")) != str((selected or {}).get("Номер записи"))]
    cargos = cargo_records.get(container) or ([cargo_index[container]] if container in cargo_index else [])
    used = set()
    for auto in ordered or [None]:
        carrier = normalize_name(value(auto or {}, "Исполнитель", "Перевозчик"))
        matching = [(index, row) for index, row in enumerate(cargos) if index not in used and carrier and normalize_name(value(row, "Перевозчик", "Исполнитель")) == carrier]
        remaining = [(index, row) for index, row in enumerate(cargos) if index not in used]
        selected_cargo = (matching or remaining or list(enumerate(cargos)))[:1]
        if selected_cargo:
            used.add(selected_cargo[0][0])
        cargo = selected_cargo[0][1] if selected_cargo else None
        record_id = str((auto or {}).get("Номер записи") or (cargo or {}).get("Номер записи") or container)
        yield record_id, cargo, auto


def selected_record(container, record_id=""):
    if record_id:
        for candidate_id, cargo, auto in records_for(container):
            if candidate_id == str(record_id):
                return cargo, auto
        raise ValueError(f"Запись ТТН/CMR {record_id} для контейнера {container} не найдена")
    return cargo_index.get(container), auto_index.get(container)


def apply_transport_context(ctx, row, request, cargo_name="", require_cargo=True):
    mode = clean(request.get("transportMode")) or transport_mode_from_ttn(row)
    if not mode and not clean(row.get("Типы грузовых единиц")) and re.fullmatch(r"[A-ZА-Я]{4}\d{7}", ctx.get("container", ""), re.IGNORECASE):
        mode = "container"
    if mode not in {"container", "non_container"}:
        if request.get("action") == "edo_options":
            return ctx
        raise ValueError("Тип перевозки не определён по ТТН/CMR. Выберите «Контейнер» или «Без контейнера» в карточке.")
    ctx["transport_mode"] = mode
    ctx["body_type"] = body_type_from_ttn(row)
    if mode == "container":
        unit_numbers = clean(row.get("Номера грузовых единиц"))
        unit_match = re.search(r"[A-ZА-Я]{4}\d{7}", unit_numbers, re.I)
        container_match = re.fullmatch(r"[A-ZА-Я]{4}\d{7}", clean(ctx.get("container")), re.I)
        if not container_match and not unit_match:
            raise ValueError("В ТТН/CMR не найден номер контейнера. Выберите «Тент / без контейнера» либо проверьте данные TMS.")
        if not container_match and unit_match:
            ctx["container"] = unit_match.group(0).upper()
    if mode == "non_container":
        ctx["cargo_name"] = clean(request.get("cargoName")) or clean(cargo_name)
        if require_cargo and not ctx["cargo_name"]:
            raise ValueError("Для перевозки без контейнера укажите наименование груза.")
        record_id = clean(row.get("Номер записи"))
        if record_id:
            ctx["container"] = record_id
            ctx["order_number"] = f"{ctx['date']:%Y%m%d}-{record_id}"
    return ctx


def forwarding_manual_departure(auto, manual_values, container):
    """Require an explicit date when TMS has no planned departure for this trip."""
    if clean(value(auto, "Плановая дата отправления")):
        return None
    entered = clean((manual_values or {}).get(f"plannedDepartureDate:{container}"))
    if not entered:
        return None
    try:
        return datetime.combine(date.fromisoformat(entered), time.min)
    except ValueError as error:
        raise ValueError(f"Для {container} укажите дату отправления в формате ГГГГ-ММ-ДД") from error


def handle(request):
    refresh_catalogs()
    refresh_sources()
    action = request.get("action")
    if action == "search_trips":
        containers = list(dict.fromkeys(clean(item).upper() for item in request.get("containers", []) if clean(item)))[:100]
        items = []
        for container_number in containers:
            records = list(records_for(container_number))
            if not records:
                records = [(container_number, None, None)]
            for record_id, cargo, auto in records:
                resolved_cargo = dict(cargo) if cargo else (dict(auto) if auto else None)
                resolved_auto = dict(auto) if auto else None
                truck_number = clean(value(resolved_auto or {}, "Номер автомашины", "Транспортное средство"))
                trailer_number = clean(value(resolved_auto or {}, "Номер прицепа"))
                carrier_name = clean(value(resolved_auto or {}, "Исполнитель", "Партнер", "Перевозчик"))
                vehicle_matches = catalogs.vehicle_matches(truck_number, carrier_name)
                vehicle = catalogs.vehicle(truck_number, carrier_name) or {}
                ownership = vehicle_ownership_kind(vehicle.get("Тип владения"))
                ownership_issue = ("Несколько карточек ТС с разным или неуказанным типом владения" if len(vehicle_matches) > 1 and not ownership
                                   else "Тип владения ТС не указан в справочнике" if truck_number and not ownership else "")
                if resolved_cargo and resolved_auto:
                    try:
                        context = generator.context({**resolved_cargo, **resolved_auto, "_container":container_number}, date.today(), clean(request.get("user")) or "Пользователь", None)
                        if context.get("loading"):
                            resolved_auto["Адрес места отправления"] = context["loading"]
                    except Exception:
                        pass
                items.append({"container":container_number, "recordId":record_id, "recordCount":len(records), "cargo":resolved_cargo, "auto":resolved_auto, "missingCargo":not resolved_cargo, "missingAuto":not auto, "cargoSource":"cargo" if cargo else ("auto" if auto else "missing"), "transportMode":transport_mode_from_ttn(resolved_auto or {}), "truckOwnership":ownership, "trailerOwnership":ownership if trailer_number else "", "vehicleOwnershipIssue":ownership_issue, "vehicleMatches":len(vehicle_matches), "vehicleContractAmbiguous":bool(vehicle.get("_contract_ambiguous"))})
        return {"items":items}
    if action == "search_orders":
        needle = clean(request.get("query")).casefold()
        limit = min(max(int(request.get("limit") or 20), 1), 100)
        container_by_row = {id(row):key for key, rows in cargo_records.items() for row in rows}
        grouped = {}
        for cargo in cargo_rows:
            order_number = clean(value(cargo, "Номер заказа"))
            container_number = container_by_row.get(id(cargo), "")
            if not order_number or not container_number:
                continue
            auto = next((auto for _, matched_cargo, auto in records_for(container_number) if matched_cargo is cargo), None) or auto_index.get(container_number) or {}
            pickup = clean(value(auto, "Место забора груза (Маршрут)"))
            delivery = clean(value(auto, "Место доставки груза (Маршрут)"))
            route = " → ".join(filter(None, (pickup, delivery))) or clean(value(auto, "Маршрут"))
            order = grouped.setdefault(order_number, {"number":order_number, "containers":[], "client":clean(value(cargo, "Клиент", "Заказчик")), "route":route, "departure":clean(value(auto, "Плановая дата отправления")), "arrival":clean(value(auto, "Плановая дата прибытия", "Последняя план дата прибытия", "ETA (план дата прибытия)"))})
            if container_number not in order["containers"]:
                order["containers"].append(container_number)
        orders = list(grouped.values())
        if needle:
            if needle.isdigit():
                orders = [order for order in orders if order["number"].casefold().startswith(needle)]
            else:
                orders = [order for order in orders if needle in " ".join([order["number"], order["client"], order["route"], *order["containers"]]).casefold()]
        return {"items":orders[:limit], "total":len(orders)}
    if action == "order_multi":
        selected = request.get("items") or []
        if not isinstance(selected, list) or not 2 <= len(selected) <= 20:
            raise ValueError("Для общей заявки выберите от 2 до 20 контейнеров")
        order_number = clean(request.get("orderNumber"))
        user = clean(request.get("user"))
        if not order_number or not user:
            raise ValueError("Укажите номер заявки и сотрудника")
        contexts, warnings, corrections = [], [], []
        seen = set()
        for selected_item in selected:
            container_number = clean(selected_item.get("container")).upper()
            if not re.fullmatch(r"[A-Z]{4}\d{7}", container_number) or container_number in seen:
                raise ValueError("Выбраны некорректные или повторяющиеся номера контейнеров")
            seen.add(container_number)
            cargo, auto = selected_record(container_number, clean(selected_item.get("recordId")))
            if not auto or not cargo:
                raise ValueError(f"Для {container_number} не найдены данные груза или ТТН/CMR")
            context = generator.context({**cargo, **auto, "_container":container_number}, date.fromisoformat(request.get("date") or date.today().isoformat()), user, None)
            apply_transport_context(context, auto, request, value(cargo, "Наименование груза"))
            if context.get("transport_mode") != "container":
                raise ValueError("Общая заявка доступна только для контейнерных перевозок")
            context["order_number"] = order_number
            context["gar_addresses"] = request.get("garAddresses") or {}
            editable, applied = prepare_manual_fields(context, "order", request.get("savedCorrections"), request.get("manualValues"))
            corrections.extend(applied)
            for role, participant_id in (request.get("edoOverrides") or {}).items():
                if role in {"client", "consignee", "carrier"} and clean(participant_id):
                    context[f"{role}_edo"] = clean(participant_id)
            warnings.extend(generator.warnings(context, ezz=True))
            contexts.append(context)
        generator.validate_ezz_group(contexts)
        warnings = list(dict.fromkeys(warnings))
        if warnings and not request.get("confirmWarnings"):
            return {"requiresConfirmation":True, "warnings":warnings, "editableFields":editable}
        filename, content = generator.ezz_multi(contexts)
        return {"filename":filename, "content":base64.b64encode(content).decode("ascii"), "appliedCorrections":corrections}
    if action == "forwarding_departure_check":
        missing = []
        for container_number in [clean(item) for item in request.get("containers", []) if clean(item)]:
            _, auto = selected_record(container_number, request.get("recordId") if len(request.get("containers", [])) == 1 else "")
            if not auto:
                raise ValueError(f"перевозка {container_number} не найдена в TMS")
            if not clean(value(auto, "Плановая дата отправления")) and forwarding_manual_departure(auto, request.get("manualValues"), container_number) is None:
                missing.append(container_number)
        if missing:
            return {"requiresConfirmation": True,
                    "warnings": [f"Для {container} в ТТН/CMR не указана плановая дата отправления. Укажите её вручную." for container in missing],
                    "editableFields": [{"id": f"plannedDepartureDate:{container}", "label": f"Дата отправления {container}", "inputType": "date"} for container in missing]}
        return {"departureChecked": True}
    if action == "forwarding_userdata_multi":
        containers = [clean(item) for item in request.get("containers", []) if clean(item)]
        services = list(dict.fromkeys(clean(item) for item in request.get("services", []) if clean(item)))
        if not containers:
            raise ValueError("в заказе нет контейнеров")
        user = clean(request.get("user"))
        missing_departures = []
        contexts = []
        for container_number in containers:
            cargo, auto = selected_record(container_number, request.get("recordId") if len(containers) == 1 else "")
            if not cargo and auto:
                cargo = dict(auto)
            if not cargo or not auto:
                raise ValueError(f"перевозка {container_number} не найдена в TMS")
            manual_departure = forwarding_manual_departure(auto, request.get("manualValues"), container_number)
            if not clean(value(auto, "Плановая дата отправления")) and manual_departure is None:
                missing_departures.append(container_number)
                continue
            context = generator.context({**cargo, **(auto or {}), "_container":container_number}, date.fromisoformat(request.get("date") or date.today().isoformat()), user, None)
            if manual_departure is not None:
                context["planned_departure_datetime"] = manual_departure
            apply_transport_context(context, auto, request, value(cargo, "Наименование груза"))
            if request.get("direction") == "taglex_to_carrier":
                context["carrier_edo"] = catalogs.preferred_edo_id(
                    context["carrier"], request.get("edoPreferences")
                )
                if not context["carrier_edo"] and context["carrier"].get("inn"):
                    options = catalogs.edo_options(context["carrier"])
                    detail = "найдено несколько ID ЭДО" if options else "не найден ID ЭДО в справочнике"
                    raise ValueError(f"Для перевозчика {context['carrier']['name']} {detail}. "
                                     "Выберите и закрепите нужный ID в карточке перевозки.")
            context["order_number"] = clean(request.get("orderNumber")) or context["order_number"]
            context["services"] = services
            context["cargo_route"] = clean(value(auto, "Маршрут"))
            unloading = value(auto, "Плановая дата прибытия", "Последняя план дата прибытия", "ETA (план дата прибытия)")
            context["forwarding_delivery_datetime"] = context["planned_arrival_datetime"] if clean(unloading) else None
            # For workspace orders Taglex is the customer and provides the container.
            # In the separate client-to-Taglex flow Taglex is the forwarder.
            context["container_provider"] = "1" if request.get("direction") == "taglex_to_carrier" else "2"
            if context["container_provider"] == "1" and context["transport_mode"] == "container":
                context["container_iso"] = container_iso_from_ttn(auto or {}, container_number)
                context["container_tare"] = "2200" if context["container_iso"].startswith("20") else "3700"
            contexts.append(context)
        if missing_departures:
            return {"requiresConfirmation":True,
                    "warnings":[f"Для {container} в ТТН/CMR не указана плановая дата отправления. Укажите её вручную." for container in missing_departures],
                    "editableFields":[{"id":f"plannedDepartureDate:{container}","label":f"Дата отправления {container}","inputType":"date"} for container in missing_departures]}
        return {"userDataXml":generator.forwarding_order_userdata(contexts, clean(request.get("signer")), request.get("direction") or "client_to_taglex")}
    container = request["container"]
    cargo, auto = selected_record(container, request.get("recordId"))
    if not cargo and auto:
        cargo = dict(auto)
    if not cargo or not auto: raise ValueError("Контейнер не найден в обоих локальных реестрах")
    row = {**cargo, **auto, "_container": container}
    # Источник места сдачи порожнего — только поле «Контейнерный сток».
    # Инструкция и перенаправление содержат свободный текст и не должны
    # подменять карточку точки маршрута.
    stock_name = clean(value(cargo, "Контейнерный сток") or value(auto, "Контейнерный сток"))
    stock = catalogs.stock(stock_name)
    user = clean(request.get("user"))
    if not user:
        raise ValueError("Не указан сотрудник, который формирует документ")
    ctx = generator.context(row, date.fromisoformat(request.get("date") or date.today().isoformat()), user, stock)
    apply_transport_context(ctx, auto, request, value(cargo, "Наименование груза"), request.get("action") != "edo_options")
    ctx["stock_name"] = stock_name
    if request.get("action") == "edo_options":
        return {"parties": [
            {"role": role, "name": ctx[role]["name"], "inn": ctx[role]["inn"], "kpp": ctx[role]["kpp"], "currentId": ctx[f"{role}_edo"], "options": catalogs.edo_options(ctx[role])}
            for role in ("client", "consignee", "carrier")
        ]}
    if request.get("action") == "resolve_order_addresses":
        return {"loading": ctx["loading"], "delivery": ctx["delivery"]}
    if request.get("action") == "forwarding_preview":
        return {"client":ctx["client"],"clientEdo":ctx["client_edo"],"consignee":ctx["consignee"],"loading":ctx["loading"],"delivery":ctx["delivery"],"contract":ctx.get("client_contract"),"number":ctx["order_number"],"date":ctx["order_date"],"weight":ctx["weight"]}
    if request.get("action") == "forwarding_userdata":
        manual_departure = forwarding_manual_departure(auto, request.get("manualValues"), container)
        if not clean(value(auto, "Плановая дата отправления")) and manual_departure is None:
            return {"requiresConfirmation": True,
                    "warnings": [f"Для {container} в ТТН/CMR не указана плановая дата отправления. Укажите её вручную."],
                    "editableFields": [{"id": f"plannedDepartureDate:{container}", "label": f"Дата отправления {container}", "inputType": "date"}]}
        if manual_departure is not None:
            ctx["planned_departure_datetime"] = manual_departure
        if request.get("direction") == "taglex_to_carrier":
            ctx["carrier_edo"] = catalogs.preferred_edo_id(ctx["carrier"], request.get("edoPreferences"))
        return {"userDataXml":generator.forwarding_order_userdata(ctx, clean(request.get("signer")), request.get("direction") or "client_to_taglex")}
    ctx["gar_addresses"] = request.get("garAddresses") or {}
    kind = request["kind"]
    editable_fields, applied_corrections = prepare_manual_fields(ctx, kind, request.get("savedCorrections"), request.get("manualValues"))
    for role, participant_id in (request.get("edoOverrides") or {}).items():
        if role in {"client", "consignee", "carrier"} and clean(participant_id):
            ctx[f"{role}_edo"] = clean(participant_id)
    warnings = generator.warnings(ctx, empty=kind == "empty", ezz=kind == "order")
    required_vehicle_fields = [field for field in editable_fields if field["id"].startswith("vehicle.")]
    if required_vehicle_fields and request.get("confirmWarnings"):
        return {"requiresConfirmation": True, "warnings": warnings, "editableFields": required_vehicle_fields}
    if warnings and not request.get("confirmWarnings"):
        return {"requiresConfirmation": True, "warnings": warnings, "editableFields": editable_fields}
    if kind == "contractor": filename, content = generator.contractor_etrn(ctx)
    elif kind == "cargo": filename, content = generator.etrn(ctx, False)
    elif kind == "empty": filename, content = generator.etrn(ctx, True)
    elif kind == "order": filename, content = generator.ezz(ctx)
    else: raise ValueError("Неизвестный тип документа")
    return {"filename":filename,"content":base64.b64encode(content).decode("ascii"),"appliedCorrections":applied_corrections}


try:
    refresh_sources()
    warmup_error = None
except Exception as error:
    warmup_error = str(error)
print(json.dumps({"ready":True, "error":warmup_error}, ensure_ascii=True), flush=True)
for line in sys.stdin:
    try:
        request=json.loads(line); result=handle(request); result["requestId"]=request.get("requestId")
    except Exception as error:
        result={"requestId":request.get("requestId") if "request" in locals() else None,"error":str(error)}
    print(json.dumps(result,ensure_ascii=True,default=str),flush=True)
