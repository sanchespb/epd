"""Apply reusable manual values only where the current TMS data is missing."""

import re
from datetime import datetime

from data_sources import clean, vehicle_ownership_kind
from xml_generator import vehicle_ownership_details


def prepare_manual_fields(ctx, kind, stored=None, submitted=None):
    stored = stored if isinstance(stored, dict) else {}
    submitted = submitted if isinstance(submitted, dict) else {}
    fields, applied = [], []
    container = clean(ctx.get("container")).upper()
    truck = clean(ctx.get("truck_number")).upper()
    vehicle_scope = f"vehicle:{truck}" if truck else f"container:{container}"

    def add(field_id, label, scope, key, current, setter, validator=None, hint=""):
        if clean(current):
            return
        candidate = clean(submitted.get(field_id)) or clean((stored.get(scope) or {}).get(key))
        if clean(submitted.get(field_id)) and validator is not None and not validator(candidate):
            raise ValueError(f"Некорректное значение поля «{label}»: {candidate}")
        if candidate and (validator is None or validator(candidate)):
            setter(candidate)
            if clean(submitted.get(field_id)):
                applied.append({"scope": scope, "key": key, "value": candidate})
            return
        fields.append({"id": field_id, "label": label, "hint": hint})

    if kind != "order":
        if truck:
            vehicle = ctx.get("truck_vehicle") or {}
            ctx["truck_vehicle"] = vehicle
            add("vehicle.ownership", "Тип владения тягачом", vehicle_scope, "ownership", vehicle_ownership_kind(vehicle.get("Тип владения")), lambda v: vehicle.__setitem__("Тип владения", vehicle_ownership_kind(v)), lambda v: v.casefold() in {"собственность", "совместная собственность супругов", "аренда", "лизинг"}, "Собственность, Совместная собственность супругов, Аренда или Лизинг")
        ownership = vehicle_ownership_details(ctx.get("truck_vehicle") or {})
        if ownership:
            vehicle = ctx["truck_vehicle"]
            add("vehicle.contract_number", "Номер договора", vehicle_scope, "contract_number", ownership.get("number"), lambda v: vehicle.__setitem__("_manual_contract_number", v), hint="Из примечания карточки автомобиля")
            add("vehicle.contract_date", "Дата договора", vehicle_scope, "contract_date", ownership.get("date"), lambda v: vehicle.__setitem__("_manual_contract_date", v), lambda v: bool(re.fullmatch(r"\d{2}\.\d{2}\.\d{4}", v)) and _valid_date(v), "ДД.ММ.ГГГГ")
            add("vehicle.owner_inn", "ИНН арендодателя / лизингодателя", vehicle_scope, "owner_inn", ownership.get("owner_inn"), lambda v: vehicle.__setitem__("_manual_owner_inn", v), lambda v: bool(re.fullmatch(r"(?:\d{10}|\d{12})", v)))
        for role, label in (("client", "заказчика"), ("consignee", "грузополучателя")):
            if role == "consignee" and kind == "empty":
                continue
            party = ctx.get(role) or {}
            scope = f"party:{clean(party.get('inn'))}" if clean(party.get("inn")) else f"container:{container}:{role}"
            add(f"{role}.phone", f"Телефон {label}", scope, "phone", party.get("phone"), lambda v, party=party: party.__setitem__("phone", v), lambda v: len(re.sub(r"\D", "", v)) >= 10)
        driver_scope = f"driver:{clean(ctx.get('driver_name')).casefold()}" if clean(ctx.get("driver_name")) else f"container:{container}:driver"
        for key, label in (("driver_name", "ФИО водителя"), ("driver_phone", "Телефон водителя"), ("driver_license", "Водительское удостоверение")):
            current = ctx.get(key)
            if key == "driver_license" and len(re.sub(r"\W", "", clean(current))) >= 7:
                continue
            def set_driver(value, field=key):
                ctx[field] = value
                if field == "driver_license":
                    ctx["driver_license_series"] = ""
                    ctx["driver_license_number"] = ""
            add(f"driver.{key}", label, driver_scope, key, current if key != "driver_license" else "", set_driver, lambda v, key=key: len(re.sub(r"\D", "", v)) >= 10 if key == "driver_phone" else len(re.sub(r"\W", "", v)) >= 7 if key == "driver_license" else len(v.split()) >= 2 if key == "driver_name" else True)
        if not ctx.get("loading_point_found") and kind != "empty":
            add("route.loading", "Полный адрес погрузки", f"container:{container}:route", "loading", "", lambda v: (ctx.__setitem__("loading", v), ctx.__setitem__("loading_point_found", True)), lambda v: len(v) >= 12)
        if not ctx.get("delivery_point_found"):
            add("route.delivery", "Полный адрес доставки", f"container:{container}:route", "delivery", "", lambda v: (ctx.__setitem__("delivery", v), ctx.__setitem__("delivery_point_found", True)), lambda v: len(v) >= 12)
        owner = ctx.get("consignee") if kind == "empty" else ctx.get("loading_owner")
        if owner is not None:
            scope = f"container:{container}:loading_owner"
            if kind != "empty":
                add("loading_owner.name", "Название владельца пункта погрузки", scope, "name", owner.get("name"), lambda v: owner.__setitem__("name", v))
                add("loading_owner.inn", "ИНН владельца пункта погрузки", scope, "inn", owner.get("inn"), lambda v: owner.__setitem__("inn", v), lambda v: bool(re.fullmatch(r"(?:\d{10}|\d{12})", v)))
                add("loading_owner.address", "Юридический адрес владельца пункта погрузки", scope, "address", owner.get("address"), lambda v: owner.__setitem__("address", v), lambda v: len(v) >= 12)
            add("loading_owner.phone", "Телефон владельца пункта погрузки", scope, "phone", owner.get("phone"), lambda v: owner.__setitem__("phone", v), lambda v: len(re.sub(r"\D", "", v)) >= 10)
    contract_role = "carrier" if kind in {"order", "contractor"} else "client"
    contract_key = "carrier_contract" if kind in {"order", "contractor"} else "client_contract"
    if not ctx.get(contract_key):
        party = ctx.get(contract_role) or {}
        scope = f"party:{clean(party.get('inn'))}:{contract_role}:contract" if clean(party.get("inn")) else f"container:{container}:{contract_role}:contract"
        contract = {}
        add(f"{contract_role}.contract_number", "Номер договора с " + ("перевозчиком" if contract_role == "carrier" else "заказчиком"), scope, "contract_number", "", lambda v: contract.__setitem__("number", v))
        add(f"{contract_role}.contract_date", "Дата договора", scope, "contract_date", "", lambda v: contract.__setitem__("date", datetime.strptime(v, "%d.%m.%Y").strftime("%Y-%m-%d")), lambda v: bool(re.fullmatch(r"\d{2}\.\d{2}\.\d{4}", v)) and _valid_date(v), "ДД.ММ.ГГГГ")
        if contract.get("number") and contract.get("date"):
            ctx[contract_key] = contract
    return fields, applied


def _valid_date(value):
    try:
        datetime.strptime(value, "%d.%m.%Y")
        return True
    except ValueError:
        return False
