from __future__ import annotations

import copy
import json
import os
import re
import uuid
import xml.etree.ElementTree as ET
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from data_sources import Catalogs, clean, normalize_name, value
from address_xml import append_gar, complete_gar, known_gar

TAGLEX = {
    "name": 'ООО "ТАГЛЕКС"', "inn": "7734515704", "kpp": "772601001",
    "phone": "+7 (495) 775-07-39",
    "address": "115191, Москва, переулок Гамсоновский, дом 5, строение 2",
    "edo": "2BM-7734515704-771001001-201411210937449434253",
}

KNOWN_PARTY_PHONES = {
    "7734515704": "+74957750739",  # ТАГЛЕКС
    "5047295775": "+79255030287",  # АГРЛ
    "7817137260": "+79255030287",  # АГМ
}

KNOWN_PARTY_PHONES_BY_NAME = {
    "АГРЛ": "+79255030287",
    "АГМ": "+79255030287",
}

KNOWN_POINT_PHONES = (
    (("ПКТ", "ПЕРВЫЙ КОНТЕЙНЕРНЫЙ ТЕРМИНАЛ"), "+78123357701"),
    (("ПЛП", "ПЕТРОЛЕСПОРТ"), "+78123638779"),
    (("КТСП", "КОНТЕЙНЕРНЫЙ ТЕРМИНАЛ САНКТ ПЕТЕРБУРГ"), "+78123357111"),
    (("НЕВА МЕТАЛЛ",), "+78127407011"),
    (("ФЕНИКС БРОНКА", "БРОНКА", "ФЕНИКС"), "+78127772000"),
)

ADDRESS_PART_PATTERNS = {
    "Индекс": r"(?<!\d)(\d{6})(?!\d)",
    "Дом": r"(?:^|[,;]\s*|\s)(?:д(?:ом)?\.?)(?!\w)\s*(?:№\s*)?([\w/-]+)",
    "Корпус": r"(?:^|[,;]\s*|\s)(?:корп(?:ус)?\.?|к\.?|стр(?:оение)?\.?)(?!\w)\s*([\w.\-/ ]+?)(?=\s*[,;]|$)",
    "Кварт": r"(?:^|[,;]\s*|\s)(?:кв(?:артира)?\.?)(?!\w)\s*([\w\-/]+)",
}


def normalize_phone(value) -> str:
    digits = re.sub(r"\D", "", clean(value))
    if len(digits) == 11 and digits.startswith("8"):
        digits = "7" + digits[1:]
    elif len(digits) == 10:
        digits = "7" + digits
    return "+" + digits if digits else ""


def known_party_phone(name: str) -> str:
    return KNOWN_PARTY_PHONES_BY_NAME.get(normalize_name(name), "")


def known_point_phone(point: dict | None) -> str:
    point = point or {}
    text = " ".join(clean(point.get(field)) for field in (
        "Номер склада и название", "Название", "Название (англ)", "Адрес", "Адрес на русском языке"
    ))
    key = normalize_name(text)
    for aliases, phone in KNOWN_POINT_PHONES:
        if any(normalize_name(alias) in key for alias in aliases):
            return phone
    return ""


def is_agm_shushary(value: str) -> bool:
    key = normalize_name(value)
    return "АГМ" in key and "ШУШАР" in key


REGION_CODES = (
    (("адыге",), "01"), (("башкортостан", "башкир"), "02"), (("бурят",), "03"),
    (("республика алтай",), "04"), (("дагестан",), "05"), (("ингуш",), "06"),
    (("кабардино",), "07"), (("калмык",), "08"), (("карачаево",), "09"),
    (("карел",), "10"), (("коми",), "11"), (("марий",), "12"),
    (("мордов",), "13"), (("саха", "якут"), "14"), (("северная осет", "алания"), "15"),
    (("татарстан",), "16"), (("тыва", "тува"), "17"), (("удмурт",), "18"),
    (("хакас",), "19"), (("чечен",), "20"), (("чуваш",), "21"),
    (("алтайск", "барнаул"), "22"), (("краснодар",), "23"), (("краснояр",), "24"),
    (("приморск", "владивосток"), "25"), (("ставропол",), "26"), (("хабаровск",), "27"),
    (("амурск", "благовещенск"), "28"), (("архангел",), "29"), (("астрахан",), "30"),
    (("белгород",), "31"), (("брянск",), "32"), (("владимир",), "33"),
    (("волгоград",), "34"), (("вологод",), "35"), (("воронеж",), "36"),
    (("иванов",), "37"), (("иркутск",), "38"), (("калининград",), "39"),
    (("калужск", "калуга"), "40"), (("камчат",), "41"), (("кемеров", "кузбасс"), "42"),
    (("кировск",), "43"), (("костром",), "44"), (("курган",), "45"),
    (("курск",), "46"), (("ленинградск",), "47"), (("липецк",), "48"),
    (("магадан",), "49"), (("московск", "электроугл"), "50"), (("мурманск",), "51"),
    (("нижегород", "нижний новгород"), "52"), (("новгородск", "великий новгород"), "53"),
    (("новосибирск",), "54"), (("омск",), "55"), (("оренбург",), "56"),
    (("орловск", "орёл", "орел"), "57"), (("пензен",), "58"), (("пермск", "пермь"), "59"),
    (("псков",), "60"), (("ростовск", "ростов-на-дону"), "61"), (("рязан",), "62"),
    (("самарск", "самара"), "63"), (("саратов",), "64"), (("сахалин",), "65"),
    (("свердловск", "екатеринбург"), "66"), (("смоленск",), "67"), (("тамбов",), "68"),
    (("тверск", "тверь"), "69"), (("томск",), "70"), (("тульск", "тула"), "71"),
    (("тюмен",), "72"), (("ульяновск",), "73"), (("челябинск",), "74"),
    (("забайкаль", "чита"), "75"), (("ярослав",), "76"), (("москва",), "77"),
    (("санкт-петербург", "спб"), "78"), (("еврейск", "биробиджан"), "79"),
    (("донецк",), "80"), (("луганск",), "81"), (("крым",), "82"),
    (("ненецк",), "83"), (("херсон",), "84"), (("запорож",), "85"),
    (("ханты-мансий", "югра"), "86"), (("чукот",), "87"),
    (("ямало-ненец",), "89"), (("севастопол",), "92"), (("байконур",), "99"),
)


def organization_name(company: dict, fallback_name: str = "") -> str:
    name = clean(company.get("Краткое наименование") or company.get("Наименование") or company.get("Полное наименование") or fallback_name)
    name = re.split(r"\s*,?\s*ИНН\s*[:№-]?\s*\d", name, maxsplit=1, flags=re.IGNORECASE)[0]
    return clean(name)[:160]


def compact_address(value: str, limit: int = 50) -> str:
    text = clean(value).strip(" ,")
    text = re.sub(r"^Россия\s*,?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"(?<!\d)\d{6}(?!\d)\s*,?\s*", "", text)
    replacements = (
        (r"\bСанкт-Петербург\b", "СПб"),
        (r"\bвн\.тер\.\s*г\.\s*", ""),
        (r"\bобласть\b", "обл."),
        (r"\bпос[её]лок\b", "п."),
        (r"\bлитера\b", "лит."),
        (r"\bулица\b", "ул."),
        (r"\bпроезд\b", "пр-д"),
        (r"\bпереулок\b", "пер."),
        (r"\bпроспект\b", "пр-т"),
        (r"\bнабережная\b", "наб."),
        (r"\bшоссе\b", "ш."),
        (r"\bкилометр\b", "км"),
        (r"\bдом\b", "д."),
        (r"\bкорпус\b", "корп."),
        (r"\bстроение\b", "стр."),
    )
    for pattern, replacement in replacements:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    text = re.sub(r"\bкм\s+(\d+)\s+км\b", r"км \1", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*,\s*", ", ", text)
    text = clean(text).strip(" ,")
    if len(text) <= limit:
        return text

    # Регион уже записывается отдельным атрибутом, поэтому при нехватке
    # места начинаем компактный адрес с города/населённого пункта.
    city = re.search(r"(?:^|,\s*)((?:г\.?|город)\s*[^,]+.*)$", text, re.IGNORECASE)
    if city:
        text = clean(city.group(1)).strip(" ,")
    text = re.sub(r",\s*(?:эт(?:аж)?|эт/каб|пом(?:ещение)?|офис|каб(?:инет)?).*?$", "", text, flags=re.IGNORECASE)
    if len(text) <= limit:
        return text

    house = re.search(r"(?:,\s*)?(д\.\s*[\w/-]+(?:\s*,\s*(?:корп\.|стр\.)\s*[\w/-]+)?)", text, re.IGNORECASE)
    suffix = clean(house.group(1)) if house else ""
    if suffix and not text.endswith(suffix):
        text = text[: house.start()].rstrip(" ,")
    reserve = len(suffix) + (2 if suffix else 0)
    prefix = text[: max(1, limit - reserve)].rstrip(" ,.-")
    return f"{prefix}, {suffix}"[:limit] if suffix else text[:limit].rstrip(" ,.-")

def party(company: dict | None, fallback_name: str = "") -> dict:
    company = company or {}
    name = organization_name(company, fallback_name)
    inn = clean(company.get("ИНН"))
    return {
        "name": name,
        "inn": inn,
        "kpp": clean(company.get("КПП")),
        "phone": normalize_phone(company.get("Телефон") or company.get("Телефон (раб.)")) or KNOWN_PARTY_PHONES.get(inn, "") or known_party_phone(name),
        "address": clean(company.get("Фактический адрес") or company.get("Юридический адрес")),
    }


def address_attributes(text: str) -> dict:
    text = clean(text)
    attrs: dict[str, str] = {}
    for key, pattern in ADDRESS_PART_PATTERNS.items():
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            attrs[key] = clean(match.group(1))

    lowered = text.lower()
    region_code = next((code for part in re.split(r'[,;]', lowered) for names, code in REGION_CODES if any(name in part for name in names)), "")
    if region_code:
        attrs["КодРегион"] = region_code

    city_match = re.search(r"(?:^|[,;]\s*)г(?:ород)?\.?\s*([^,;]+)", text, re.IGNORECASE)
    if city_match:
        attrs["Город"] = clean(city_match.group(1))[:50]

    parts = [clean(part) for part in re.split(r"[,;]", text) if clean(part)]
    house_part_index = next(
        (
            index
            for index, part in enumerate(parts)
            if re.search(ADDRESS_PART_PATTERNS["Дом"], part, re.IGNORECASE)
        ),
        len(parts),
    )
    street_candidates = []
    for part in parts[:house_part_index]:
        if re.fullmatch(r"\d{6}", part):
            continue
        if re.match(r"^(?:Россия|[гсдп]\.?\s|город\s|село\s|деревня\s|пос(?:елок)?\.?\s)", part, re.IGNORECASE):
            continue
        if re.search(r"(?:область|обл\.?|край|республика)$", part, re.IGNORECASE):
            continue
        street_candidates.append(part)
    if street_candidates:
        street = street_candidates[-1]
    else:
        street = re.sub(r"(?<!\d)\d{6}(?!\d)", "", text).strip(" ,")
    street_part = next((part for part in parts if re.search(r'(?:^|\s)(?:ул(?:ица)?\.?|ш(?:оссе)?\.?|пр-кт|проспект|пр-д|проезд|пер(?:еулок)?\.?|квартал)(?:\s|$)', part, re.I)), '')
    if street_part and len(street_part) <= 50:
        attrs['Улица'] = street_part
        suffix_city = next((part for part in parts if re.search(r'\sг\.?$', part, re.I)), '')
        if suffix_city and 'Город' not in attrs:
            attrs['Город'] = re.sub(r'\sг\.?$', '', suffix_city, flags=re.I)[:50]
        locality = next((part for part in parts if re.match(r'^(?:село|деревня|пос[её]лок|п\.)\s', part, re.I)), '')
        if locality:
            attrs['НаселПункт'] = locality[:50]
        extras = re.findall(r'(?:^|[,;]\s*)(?:корп(?:ус)?\.?|стр(?:оение)?\.?|лит(?:ера)?\.?)\s*[\w/-]+', text, re.I)
        if extras:
            attrs['Корпус'] = ', '.join(x.strip(' ,;') for x in extras)[:20]
    else:
        attrs['Улица'] = compact_address(text) or 'Адрес уточняется'

    # Индекс обычно приходит в адресе точки. Для известных адресов без
    # индекса используем адресный справочник, а не индекс юридического лица.
    if "Индекс" not in attrs and "нижний новгород" in lowered and "федосеенко" in lowered and re.search(r"\b54\b", lowered):
        attrs["Индекс"] = "603037"
    if "Индекс" not in attrs and "автозавод" in lowered and ("шушар" in lowered or "санкт-петербург" in lowered or "спб" in lowered):
        attrs["Индекс"] = "196657"
    if "Индекс" not in attrs and "пресненск" in lowered and re.search(r"\b2\b", lowered):
        attrs["Индекс"] = "123112"
    return attrs


def _set_address(wrapper: ET.Element | None, text: str, child_name: str = "АдрРФ", gar: dict | None = None):
    if wrapper is None:
        return
    for child in list(wrapper):
        wrapper.remove(child)
    if complete_gar(text, gar):
        append_gar(wrapper, gar)
        return
    ET.SubElement(wrapper, child_name, address_attributes(text))


def _set_legal(node: ET.Element | None, data: dict):
    if node is None:
        return
    legal = node.find(".//СвЮЛУч")
    if legal is not None:
        legal.attrib = {"НаимОрг": data["name"] or "Не указано", "ИННЮЛ": data["inn"] or "0000000000"}
        if data.get("kpp"):
            legal.set("КПП", data["kpp"])
    address = node.find(".//Адрес")
    if address is not None:
        _set_address(address, data.get("address", ""), gar=data.get('gar'))
    contact = node.find(".//Контакт")
    contact_tag = "Контакт"
    if contact is None:
        contact = node.find(".//Конт")
        contact_tag = "Конт"
    phone_value = clean(data.get("phone"))
    if not phone_value:
        if contact is not None:
            parent = next((item for item in node.iter() if contact in list(item)), None)
            if parent is not None:
                parent.remove(contact)
        return
    if contact is None:
        requisites = node.find(".//РекИдентГО")
        if requisites is None:
            requisites = node.find(".//РекИдентЗак")
        if requisites is None:
            requisites = node.find(".//РекИдентГП")
        if requisites is None and node.find("ИдСв") is not None:
            contact_tag = "Конт"
        contact = ET.SubElement(requisites if requisites is not None else node, contact_tag)
    phone = contact.find("Тлф")
    if phone is None:
        phone = ET.SubElement(contact, "Тлф")
    phone.text = phone_value


def _set_ezz_shipper_phone(node: ET.Element | None, phone_value: str):
    """Write the EZZ shipper phone to the exact schema node used by Kontur."""
    if node is None:
        return
    for legacy in node.findall("Контакт"):
        node.remove(legacy)
    contact = node.find("Конт")
    if contact is None:
        contact = ET.SubElement(node, "Конт")
    phone = contact.find("Тлф")
    if phone is None:
        phone = ET.SubElement(contact, "Тлф")
    phone.text = clean(phone_value)


def _set_contract(node: ET.Element | None, contract: dict | None, party_inns: tuple[str, ...] = ()):
    if node is None:
        return
    existing = node.find("ДогУслПер")
    if not contract:
        if existing is not None:
            node.remove(existing)
        return
    if existing is None:
        existing = ET.SubElement(node, "ДогУслПер")
    for stale in list(existing.findall("ИдРекСост")):
        existing.remove(stale)
    for inn in party_inns:
        if clean(inn):
            ET.SubElement(ET.SubElement(existing, "ИдРекСост"), "ИННЮЛ").text = clean(inn)
    existing.set("НаимДок", clean(contract.get("title")) or "Договор")
    existing.set("НомерДок", clean(contract.get("number")))
    raw_date = clean(contract.get("date"))
    if raw_date:
        try:
            existing.set("ДатаДок", datetime.strptime(raw_date, "%Y-%m-%d").strftime("%d.%m.%Y"))
        except ValueError:
            existing.set("ДатаДок", raw_date)
    else:
        existing.attrib.pop("ДатаДок", None)


def _as_datetime(value, fallback: datetime) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime.combine(value, time(9))
    text = clean(value)
    if not text:
        return fallback
    def parse_iso():
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(timezone(timedelta(hours=3))).replace(tzinfo=None)
        return parsed

    for parser in (
        parse_iso,
        lambda: datetime.strptime(text, "%d.%m.%Y %H:%M"),
        lambda: datetime.strptime(text, "%d.%m.%Y"),
    ):
        try:
            return parser()
        except ValueError:
            pass
    return fallback


def _epd_datetime(value: datetime) -> str:
    return value.strftime("%d.%m.%YT%H:%M:%S+03:00")


def _fio(full_name: str) -> dict:
    parts = clean(full_name).split()
    return {
        "Фамилия": parts[0] if parts else "Неуказано",
        "Имя": parts[1] if len(parts) > 1 else "Неуказано",
        "Отчество": parts[2] if len(parts) > 2 else "Неуказано",
    }


def _serialize(root: ET.Element) -> bytes:
    ET.indent(root, space="  ")
    return ET.tostring(root, encoding="windows-1251", xml_declaration=True)


class Generator:
    def __init__(self, resources: Path, catalogs: Catalogs):
        self.catalogs = catalogs
        self.etrn_template = ET.fromstring((resources / "etrn_cargo_sample.xml").read_bytes().decode("windows-1251"))
        self.ezz_template = ET.fromstring((resources / "ezz_sample.xml").read_bytes().decode("windows-1251"))
        embedded_file = resources / "contracts.json"
        self.contracts = json.loads(embedded_file.read_text("utf-8-sig")) if embedded_file.exists() else []
        configured_contracts = clean(os.getenv("AGR_CONTRACTS_FILE"))
        configured_file = Path(configured_contracts) if configured_contracts else None
        if configured_file and configured_file.exists() and configured_file.resolve() != embedded_file.resolve():
            self.contracts.extend(json.loads(configured_file.read_text("utf-8-sig")))

    def _contract_for(self, party_name: str, role: str = "client") -> dict | None:
        key = normalize_name(party_name)

        def contract_parties(item):
            aliases = item.get("aliases") if isinstance(item.get("aliases"), list) else []
            if role == "carrier":
                primary = item.get("carrier") or item.get("counterparty") or (
                    item.get("client") if clean(item.get("role")).lower() == "carrier" else ""
                )
            else:
                primary = item.get("client") or item.get("counterparty")
            return [primary, *aliases]

        matches = [
            item for item in self.contracts
            if any(normalize_name(name) == key for name in contract_parties(item) if clean(name))
            and "нет номера договора" not in clean(item.get("number")).lower()
        ]
        if not matches:
            return None
        matches.sort(key=lambda item: (clean(item.get("last_invoice")), int(item.get("invoice_count") or 0), clean(item.get("date"))), reverse=True)
        return matches[0]

    def context(self, row: dict, trip_date: date, user: str, stock: dict | None = None) -> dict:
        container = clean(row["_container"])
        client_name = clean(value(row, "Клиент", "Заказчик"))
        explicit_consignee = clean(value(row, "Грузополучатель"))
        consignee_text = re.split(r"\s+по\s+поручению\b", explicit_consignee, maxsplit=1, flags=re.IGNORECASE)[0]
        consignee_inn_match = re.search(r"\bИНН\s*[:№-]?\s*(\d{10}|\d{12})\b", consignee_text, flags=re.IGNORECASE)
        consignee_inn = consignee_inn_match.group(1) if consignee_inn_match else ""
        consignee_name = clean(re.sub(r"\s+ИНН\s*[:№-]?\s*\d{10,12}\b.*$", "", consignee_text, flags=re.IGNORECASE)) if explicit_consignee else client_name
        carrier_name = clean(value(row, "Исполнитель", "Партнер", "Перевозчик"))
        client_company = self.catalogs.company(client_name)
        consignee_company = self.catalogs.company(consignee_name, inn=consignee_inn)
        carrier_company = self.catalogs.company(carrier_name)
        driver_name = clean(value(row, "Водитель", "ФИО водителя"))
        driver = self.catalogs.driver(driver_name, carrier_name) or {}
        truck_number = clean(value(row, "Номер автомашины", "Транспортное средство"))
        truck = self.catalogs.vehicle(truck_number) or {}
        route = clean(value(row, "Маршрут"))
        route_names = [
            clean(re.sub(r"^\(RU\)\s*", "", item, flags=re.IGNORECASE))
            for item in re.split(r"\s*(?:->|→|—>)\s*", route)
            if clean(item)
        ]
        loading_name = route_names[0] if route_names else clean(value(row, "Место отправления", "Последняя точка прибытия"))
        delivery_name = route_names[-1] if len(route_names) > 1 else clean(value(row, "Место прибытия", "Последняя точка прибытия", "Места дислокации грузовых единиц"))
        if not explicit_consignee and is_agm_shushary(delivery_name):
            consignee_name = "АГМ"
            consignee_company = self.catalogs.company(consignee_name)
        loading_point = self.catalogs.point(loading_name)
        delivery_point = self.catalogs.point(delivery_name)

        def point_address(point, fallback):
            if normalize_name(fallback) == normalize_name("Электроугли"):
                return "142461, Московская область, городской округ Богородский, территория Носовихинское шоссе, 26-й километр, д. 1"
            point_name = normalize_name(clean((point or {}).get("Название")) or fallback)
            if is_agm_shushary(point_name) or is_agm_shushary(fallback):
                return "196657, Санкт-Петербург, посёлок Шушары, ул. Автозаводская, д. 2, лит. А"
            address = clean((point or {}).get("Адрес на русском языке") or (point or {}).get("Адрес") or fallback)
            postal_code = clean((point or {}).get("Индекс"))
            if postal_code and re.fullmatch(r"\d{6}", postal_code) and not re.search(r"(?<!\d)\d{6}(?!\d)", address):
                address = f"{postal_code}, {address}"
            return address

        def point_owner(point):
            inn = clean((point or {}).get("ИНН"))
            company = self.catalogs.company(inn=inn) if inn else None
            result = party(company, clean((point or {}).get("Название")))
            result["inn"] = result.get("inn") or inn
            if point:
                result["address"] = point_address(point, result.get("address"))
                result["phone"] = normalize_phone(point.get("Номер телефона")) or known_point_phone(point) or result.get("phone", "")
            return result

        planned_departure_datetime = _as_datetime(
            value(row, "Плановая дата отправления"), datetime.combine(trip_date, time(9))
        )
        order_date = min(trip_date, planned_departure_datetime.date())
        return {
            "container": container,
            "date": trip_date,
            "user": user,
            "client": party(client_company, client_name),
            "client_edo": self.catalogs.edo_id(client_company),
            "order_number": f"{order_date:%Y%m%d}-{container}",
            "order_date": order_date.strftime("%d.%m.%Y"),
            "client_contract": self._contract_for(client_name),
            "carrier_contract": self._contract_for(carrier_name, role="carrier"),
            "consignee": party(consignee_company, consignee_name),
            "consignee_edo": self.catalogs.edo_id(consignee_company),
            "carrier": party(carrier_company, carrier_name),
            "carrier_edo": self.catalogs.edo_id(carrier_company),
            "driver_name": driver_name or clean(driver.get("Полное имя")),
            "driver_phone": normalize_phone(value(row, "Телефон водителя") or driver.get("Телефон 1") or driver.get("Телефон 2")),
            "driver_license_series": clean(driver.get("Серия водительского удостоверения")),
            "driver_license_number": clean(driver.get("Номер водительского удостоверения")),
            "driver_license": clean(driver.get("Серия водительского удостоверения")) + clean(driver.get("Номер водительского удостоверения")),
            # В справочнике TMS дата выдачи ВУ хранится в поле
            # «Дата окончания доверенности» по согласованной бизнес-логике.
            "driver_license_issue_date": _as_datetime(driver.get("Дата окончания доверенности"), None),
            "truck_number": truck_number or clean(truck.get("Государственный номер")),
            "truck_brand": clean(truck.get("Марка")) or "Тягач",
            "trailer": clean(value(row, "Номер прицепа")),
            "weight": clean(value(row, "Вес брутто")) or "0",
            "seals": ", ".join(dict.fromkeys(filter(None, [clean(value(row, "Номер пломбы")), clean(value(row, "Номер пломбы 2"))]))),
            "loading": point_address(loading_point, loading_name),
            "delivery": point_address(delivery_point, delivery_name),
            "loading_owner": point_owner(loading_point),
            "delivery_owner": point_owner(delivery_point),
            "loading_point_found": bool(loading_point),
            "delivery_point_found": bool(delivery_point),
            "delivery_datetime": _as_datetime(value(row, "Планируемая дата доставки на склад", "Плановая дата доставки на склад", "Плановая дата прибытия", "Последняя план дата прибытия", "ETA (план дата прибытия)"), datetime.combine(trip_date, time(9))),
            "planned_arrival_datetime": _as_datetime(value(row, "Плановая дата прибытия", "Последняя план дата прибытия", "ETA (план дата прибытия)"), _as_datetime(value(row, "Планируемая дата доставки на склад", "Плановая дата доставки на склад"), datetime.combine(trip_date, time(17)))),
            "empty_delivery_datetime": _as_datetime(value(row, "Дата сдачи порожнего"), _as_datetime(value(row, "Плановая дата прибытия", "Последняя план дата прибытия", "ETA (план дата прибытия)"), datetime.combine(trip_date, time(9)))),
            "planned_departure_datetime": planned_departure_datetime,
            # По согласованной логике ЭТрН фактическое прибытие на погрузку
            # совпадает с заявленной подачей; фактическое убытие ставится на час позже.
            "actual_departure_datetime": _as_datetime(value(row, "Плановая дата отправления"), datetime.combine(trip_date, time(9))),
            "stock": stock,
        }

    def fill_missing_kpp(self, ctx):
        for role in ('client', 'consignee', 'carrier'):
            data = ctx.get(role) or {}
            if not clean(data.get('kpp')):
                data['kpp'] = self.catalogs.kpp_for_edo(data.get('inn', ''), ctx.get(role + '_edo', ''))

    def etrn(self, ctx: dict, empty: bool = False) -> tuple[str, bytes]:
        self.fill_missing_kpp(ctx)
        root = copy.deepcopy(self.etrn_template)
        now = datetime.now()
        consignee = TAGLEX if empty else ctx["consignee"]
        consignee_edo = TAGLEX["edo"] if empty else ctx["consignee_edo"]
        file_id = (
            f"ON_TRNACLGROT_{ctx['carrier_edo']}_{consignee_edo}_{TAGLEX['edo']}_0_"
            f"{ctx['date']:%Y%m%d}_{uuid.uuid4()}"
        )
        root.set("ИдФайл", file_id)
        root.set("ВерсПрог", "AGR Universal ETRN 1.0")
        doc = root.find("Документ")
        doc.set("ДатИнфГО", now.strftime("%d.%m.%Y"))
        doc.set("ВрИнфГО", now.strftime("%H:%M:%S"))
        info = doc.find("СодИнфГО")
        info.set("НомерТрН", f"{ctx['date']:%Y%m%d}-{ctx['container']}-{'EMPTY' if empty else 'CARGO'}")
        info.set("ДатаТрН", ctx["date"].strftime("%d.%m.%Y"))
        info.set("НомЗак", ctx["order_number"])
        info.set("ДатаЗак", ctx["order_date"])
        _set_legal(info.find("СвГО"), TAGLEX)
        _set_legal(info.find("СвЗак"), ctx["client"])
        _set_contract(info.find("СвЗак"), ctx.get("client_contract"), (TAGLEX["inn"], ctx["client"]["inn"]))
        _set_legal(info.find("СвГП"), consignee)
        delivery = (
            clean((ctx["stock"] or {}).get("Адрес на русском языке") or (ctx["stock"] or {}).get("Адрес"))
            if empty else ctx["delivery"]
        )
        _set_address(info.find("СвГП/АдресДостГр"), delivery, "АдресРФ")
        delivery_time = ctx["empty_delivery_datetime"] if empty else ctx["delivery_datetime"]
        instructions = info.find("УказГО")
        if instructions is not None:
            instructions.set("ДатВрДостГр", _epd_datetime(delivery_time))
            if not empty and ctx.get("seals"):
                instructions.set("СвПломба", ctx["seals"])
            else:
                instructions.attrib.pop("СвПломба", None)
        cargo = info.find("СвГруз/ОпГруз")
        cargo.set("НаимГруз", f"Порожний контейнер {ctx['container']}" if empty else f"Контейнер {ctx['container']}")
        if empty:
            cargo.set("СпУпак", "Отсутствует")
        container_info = cargo.find("СвКонтейн")
        if container_info is not None:
            cargo.remove(container_info)
        cargo.find("ПлМасГруз").set("МасБрутЗнач", "0" if empty else ctx["weight"])
        _set_legal(info.find("СвПер"), ctx["carrier"])
        driver = info.find("СвВодит")
        license_series = re.sub(r"\W", "", clean(ctx.get("driver_license_series")))
        license_number = re.sub(r"\W", "", clean(ctx.get("driver_license_number")))
        license_value = license_series + license_number or re.sub(r"\W", "", ctx["driver_license"])
        has_driver_data = bool(ctx["driver_name"] or ctx["driver_phone"] or license_value)
        if driver is not None and has_driver_data:
            if license_series and license_number:
                driver.set("СерВУ", license_series)
                driver.set("НомВУ", license_number)
            elif len(license_value) >= 7:
                driver.set("СерВУ", license_value[:-6])
                driver.set("НомВУ", license_value[-6:])
            else:
                driver.attrib.pop("СерВУ", None)
                driver.attrib.pop("НомВУ", None)
            if ctx.get("driver_license_issue_date"):
                driver.set("ДатаВыдВУ", ctx["driver_license_issue_date"].strftime("%d.%m.%Y"))
            else:
                driver.attrib.pop("ДатаВыдВУ", None)
            phone = driver.find("Тлф")
            if ctx["driver_phone"]:
                if phone is None:
                    phone = ET.SubElement(driver, "Тлф")
                phone.text = ctx["driver_phone"]
            elif phone is not None:
                driver.remove(phone)
            driver_name = driver.find("ФИО")
            if ctx["driver_name"]:
                if driver_name is None:
                    driver_name = ET.SubElement(driver, "ФИО")
                driver_name.attrib = _fio(ctx["driver_name"])
            elif driver_name is not None:
                driver.remove(driver_name)
        elif driver is not None:
            info.remove(driver)
        truck = info.find("СвТС/ТС")
        truck.set("РегНомер", ctx["truck_number"] or "НЕУКАЗАН")
        truck.find("ПарТС").set("Марка", ctx["truck_brand"])
        trailer = info.find("СвТС/Прицеп")
        trailer.set("РегНомер", ctx["trailer"] or "ОТСУТСТВУЕТ")
        planned_departure = ctx["planned_departure_datetime"]
        actual_departure = ctx["actual_departure_datetime"]
        loading = info.find("СвПогруз")
        loading.set("ЗаявПогр", _epd_datetime(planned_departure))
        loading.set("ФДатВрПриб", _epd_datetime(actual_departure))
        loading.set("ФДатВрУбыт", _epd_datetime(actual_departure + timedelta(hours=1)))
        loading.set("МасБрутОтгр", "0" if empty else ctx["weight"])
        physical_loading = ctx["delivery"] if empty else ctx["loading"]
        _set_address(loading.find("ФАдресПогр"), physical_loading, "АдресРФ")
        loading_person = loading.find("СвЛицПогрГр/РабЛицПогрГр")
        if loading_person is not None:
            loading_person.set("Должность", "Сотрудник")
            loading_person.find("ФИО").attrib = _fio(ctx["user"])
        owner = loading.find("ВладИнфр")
        # Для порожней перевозки погрузка выполняется на складе, куда был
        # доставлен груз. Владельцем этого объекта является грузополучатель
        # грузовой перевозки (клиент), а не грузоотправитель порожней ЭТрН.
        owner_data = dict(ctx["consignee"]) if empty else ctx["loading_owner"]
        if empty:
            owner_data["address"] = ctx["delivery"]
        if owner is not None and owner_data.get("inn"):
            owner.set("СовпГОВ", "2")
            _set_legal(owner, owner_data)
        elif owner is not None:
            loading.remove(owner)
        signer = doc.find("Подписант")
        signer.set("СтатПодп", "1")
        signer.set("Должн", "Сотрудник")
        signer.attrib.pop("ИдСистХран", None)
        signer.find("ФИО").attrib = _fio(ctx["user"])
        for child in list(signer):
            if child.tag != "ФИО":
                signer.remove(child)
        return file_id + ".xml", _serialize(root)

    def ezz(self, ctx: dict) -> tuple[str, bytes]:
        self.fill_missing_kpp(ctx)
        root = copy.deepcopy(self.ezz_template)
        now = datetime.now()
        file_id = f"ON_ZAKZVGO_{ctx['carrier_edo']}_{TAGLEX['edo']}_0_{ctx['date']:%Y%m%d}_{uuid.uuid4()}"
        root.set("ИдФайл", file_id)
        root.set("ВерсПрог", "AGR Universal EZZ 1.0")
        doc = root.find("Документ")
        doc.set("ДатИнфГО", now.strftime("%d.%m.%Y"))
        doc.set("ВрИнфГО", now.strftime("%H:%M:%S"))
        info = doc.find("СодИнфГО")
        contract = root.find(".//ДогОргПрвз")
        if contract is not None:
            for stale in list(contract.findall('ИдРекСост')):
                contract.remove(stale)
            for inn in (ctx['carrier']['inn'], TAGLEX['inn']):
                if clean(inn):
                    ET.SubElement(ET.SubElement(contract, 'ИдРекСост'), 'ИННЮЛ').text = clean(inn)
        selected_contract = ctx.get("carrier_contract")
        if contract is not None:
            if selected_contract:
                contract.set("НомерДок", clean(selected_contract.get("number")))
                contract_date = clean(selected_contract.get("date"))
                if contract_date:
                    contract.set("ДатаДок", datetime.strptime(contract_date, "%Y-%m-%d").strftime("%d.%m.%Y"))
                else:
                    contract.attrib.pop("ДатаДок", None)
            else:
                contract.set("НомерДок", "Не найден в справочнике договоров")
                contract.attrib.pop("ДатаДок", None)
        info.set("НомЗак", ctx["order_number"])
        info.set("ДатаЗак", ctx["order_date"])
        shipper = info.find("СвГО")
        _set_legal(shipper, {**TAGLEX, 'gar': known_gar(TAGLEX['address'])})
        _set_ezz_shipper_phone(shipper, TAGLEX["phone"])
        _set_legal(info.find("СвПрв"), ctx["carrier"])
        start = ctx["planned_departure_datetime"]
        finish = ctx["planned_arrival_datetime"]
        point = info.find("ПунктПод")
        point.set("ДатВрПод", _epd_datetime(start))
        gar_addresses = dict(ctx.get("gar_addresses") or {})
        for role in ('loading', 'delivery'):
            gar_addresses[role] = known_gar(ctx[role]) or gar_addresses.get(role)
        _set_address(point.find("АдрПунктПод/Адрес"), ctx["loading"], gar=gar_addresses.get("loading"))
        route_points = info.findall("АдрПункт")
        route_points[0].set("ДатВрОпер", _epd_datetime(start))
        route_points[1].set("ДатВрОпер", _epd_datetime(finish))
        _set_address(route_points[0].find("АдресПункт/Адрес"), ctx["loading"], gar=gar_addresses.get("loading"))
        _set_address(route_points[1].find("АдресПункт/Адрес"), ctx["delivery"], gar=gar_addresses.get("delivery"))
        # Никогда не оставляем владельца из образца XML (Янино).
        for route_point in route_points:
            for owner in list(route_point.findall("ОргВладИнфр")):
                route_point.remove(owner)
        loading_owner = ctx.get("loading_owner") or {}
        if clean(loading_owner.get("name")) and clean(loading_owner.get("inn")):
            ET.SubElement(route_points[0], "ОргВладИнфр", {
                "НаимВладИнфр": clean(loading_owner["name"]),
                "ИННВладИнфр": clean(loading_owner["inn"]),
            })
        cargo = info.find("ОпГруз")
        cargo.set("НаимГруз", f"Контейнер {ctx['container']}")
        cargo.find("МасГруз").set("МасБрутЗнач", ctx["weight"])
        signer = doc.find("ПодпИнфГО")
        signer.set("СпосПодтПолном", "1")
        signer.find("ФИО").attrib = _fio(ctx["user"])
        return file_id + ".xml", _serialize(root)
