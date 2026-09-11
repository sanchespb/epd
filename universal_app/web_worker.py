from __future__ import annotations

import base64
import json
import os
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from data_sources import Catalogs, clean, normalize_name, read_counteragents, read_xlsx, value
from server_generator import Generator


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
    global source_stamp, cargo_rows, cargo_index, auto_index
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
    cargo_index = {}
    for row in cargo_rows:
        for cell in row.values():
            text = clean(cell)
            if len(text) >= 11:
                import re
                match = re.search(r"[A-ZА-Я]{4}\d{7}", text.upper())
                if match: cargo_index[match.group()] = row; break
    auto_index = {}
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
        match = re.search(r"[A-ZА-Я]{4}\d{7}", clean(row.get("Номера грузовых единиц")).upper())
        if not match:
            continue
        container = match.group()
        if container not in auto_index:
            # TMS exports rows by ID descending: keep the newest operation.
            auto_index[container] = dict(row)
            continue
        selected = auto_index[container]
        expected_carrier = clean(value(cargo_index.get(container) or {}, "Перевозчик", "Исполнитель"))
        if operation_score(row, expected_carrier) > operation_score(selected, expected_carrier):
            selected, row = dict(row), selected
            auto_index[container] = selected
        if normalize_name(value(selected, "Исполнитель", "Перевозчик")) == normalize_name(value(row, "Исполнитель", "Перевозчик")):
            for field in supplemental_fields:
                if not clean(selected.get(field)) and clean(row.get(field)):
                    selected[field] = row[field]
    source_stamp = stamp


def handle(request):
    refresh_catalogs()
    refresh_sources()
    action = request.get("action")
    if action == "search_trips":
        containers = list(dict.fromkeys(clean(item).upper() for item in request.get("containers", []) if clean(item)))[:100]
        items = []
        for container_number in containers:
            cargo, auto = cargo_index.get(container_number), auto_index.get(container_number)
            resolved_auto = dict(auto) if auto else None
            if cargo and resolved_auto:
                try:
                    context = generator.context({**cargo, **resolved_auto, "_container":container_number}, date.today(), clean(request.get("user")) or "Пользователь", None)
                    if context.get("loading"):
                        resolved_auto["Адрес места отправления"] = context["loading"]
                except Exception:
                    pass
            items.append({"container":container_number, "cargo":cargo, "auto":resolved_auto, "missingCargo":not cargo, "missingAuto":not auto})
        return {"items":items}
    if action == "search_orders":
        needle = clean(request.get("query")).casefold()
        limit = min(max(int(request.get("limit") or 20), 1), 100)
        container_by_row = {id(row):key for key, row in cargo_index.items()}
        grouped = {}
        for cargo in cargo_rows:
            order_number = clean(value(cargo, "Номер заказа"))
            container_number = container_by_row.get(id(cargo), "")
            if not order_number or not container_number:
                continue
            auto = auto_index.get(container_number) or {}
            order = grouped.setdefault(order_number, {"number":order_number, "containers":[], "client":clean(value(cargo, "Клиент", "Заказчик")), "route":clean(value(auto, "Маршрут")), "departure":clean(value(auto, "Плановая дата отправления")), "arrival":clean(value(auto, "Плановая дата прибытия", "Последняя план дата прибытия", "ETA (план дата прибытия)"))})
            if container_number not in order["containers"]:
                order["containers"].append(container_number)
        orders = list(grouped.values())
        if needle:
            orders = [order for order in orders if needle in " ".join([order["number"], order["client"], order["route"], *order["containers"]]).casefold()]
        return {"items":orders[:limit], "total":len(orders)}
    if action == "forwarding_userdata_multi":
        containers = [clean(item) for item in request.get("containers", []) if clean(item)]
        if not containers:
            raise ValueError("в заказе нет контейнеров")
        user = clean(request.get("user"))
        contexts = []
        for container_number in containers:
            cargo, auto = cargo_index.get(container_number), auto_index.get(container_number)
            if not cargo or not auto:
                raise ValueError(f"контейнер {container_number} не найден в обоих реестрах")
            context = generator.context({**cargo, **auto, "_container":container_number}, date.fromisoformat(request.get("date") or date.today().isoformat()), user, None)
            context["order_number"] = clean(request.get("orderNumber")) or context["order_number"]
            contexts.append(context)
        return {"userDataXml":generator.forwarding_order_userdata(contexts, clean(request.get("signer")))}
    container = request["container"]
    cargo, auto = cargo_index.get(container), auto_index.get(container)
    if not cargo or not auto: raise ValueError("Контейнер не найден в обоих локальных реестрах")
    row = {**cargo, **auto, "_container": container}
    instruction = clean(value(row, "Перенаправление сдачи порожнего", "Инструкция на сдачу порожнего", "Контейнерный сток"))
    stock = catalogs.stock(instruction)
    if not stock and instruction: stock = {"Название":instruction,"Адрес":instruction,"Адрес на русском языке":instruction}
    user = clean(request.get("user"))
    if not user:
        raise ValueError("Не указан сотрудник, который формирует документ")
    ctx = generator.context(row, date.fromisoformat(request.get("date") or date.today().isoformat()), user, stock)
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
        return {"userDataXml":generator.forwarding_order_userdata(ctx, clean(request.get("signer")))}
    ctx["gar_addresses"] = request.get("garAddresses") or {}
    for role, participant_id in (request.get("edoOverrides") or {}).items():
        if role in {"client", "consignee", "carrier"} and clean(participant_id):
            ctx[f"{role}_edo"] = clean(participant_id)
    kind = request["kind"]
    warnings = generator.warnings(ctx, empty=kind == "empty", ezz=kind == "order")
    if warnings and not request.get("confirmWarnings"):
        return {"requiresConfirmation": True, "warnings": warnings}
    if kind == "cargo": filename, content = generator.etrn(ctx, False)
    elif kind == "empty": filename, content = generator.etrn(ctx, True)
    elif kind == "order": filename, content = generator.ezz(ctx)
    else: raise ValueError("Неизвестный тип документа")
    return {"filename":filename,"content":base64.b64encode(content).decode("ascii")}


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
