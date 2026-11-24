import unittest
import xml.etree.ElementTree as ET
from datetime import date, datetime
from pathlib import Path
from address_xml import known_gar, complete_gar
from data_sources import Catalogs
from server_generator import Generator as ServerGenerator
from xml_generator import Generator, TAGLEX, address_attributes, _set_address, _set_contract, cargo_packaging, known_point_phone, normalize_vehicle_number, party, vehicle_ownership_details
from container_types import container_iso_from_ttn, container_tare_from_ttn, transport_mode_from_ttn, body_type_from_ttn
from manual_corrections import prepare_manual_fields


class AddressRegressions(unittest.TestCase):
    def test_petro_house_is_not_repeated_in_street(self):
        attrs = address_attributes("196624, г. Санкт-Петербург, п. Шушары, Московское шоссе д. 153")
        self.assertEqual(attrs["Улица"], "Московское шоссе")
        self.assertEqual(attrs["Дом"], "153")
        self.assertEqual(attrs["Индекс"], "196624")

    def test_spousal_ownership_is_selected_for_the_trip_carrier(self):
        from data_sources import vehicle_ownership_kind
        catalogs = Catalogs()
        catalogs.vehicles = [
            {"Государственный номер":"Е670РС198","Автоперевозчик":'ООО "Локом"',"Тип владения":"Аренда"},
            {"Государственный номер":"Е670РС198","Автоперевозчик":"ИП ПАСИШНИК СЕРГЕЙ ИВАНОВИЧ","Тип владения":"Совместная собственность супругов"},
        ]
        vehicle = catalogs.vehicle("E670PC198","ПАСИШНИК СЕРГЕЙ ИВАНОВИЧ")
        self.assertEqual(vehicle["Тип владения"],"Совместная собственность супругов")
        self.assertEqual(vehicle_ownership_kind(vehicle["Тип владения"]),"Совместная собственность супругов")
        self.assertEqual(vehicle_ownership_kind("2"),"Совместная собственность супругов")
        generator = Generator(Path(__file__).parent / "resources", catalogs)
        ctx = generator.context({"_container":"TEST1234567","Исполнитель":"ИП ПАСИШНИК СЕРГЕЙ ИВАНОВИЧ","Номер автомашины":"Е670РС198","Номер прицепа":"АВ123478"}, date(2026,11,19), "Иванов Иван Иванович", None)
        _, content = generator.etrn(ctx)
        root = ET.fromstring(content)
        self.assertEqual(root.find(".//СвТС/ТС").get("ТипВлад"),"2")
        self.assertEqual(root.find(".//СвТС/Прицеп").get("ТипВлад"),"2")
        self.assertIsNone(root.find(".//СвТС/ТС/ОснАрЛиз"))
        self.assertIsNone(catalogs.vehicle("Е670РС198","Другой перевозчик"))
        self.assertEqual(catalogs.vehicle("Е670РС198","Локом")["Тип владения"],"Аренда")

    def test_duplicate_vehicle_cards_preserve_shared_rental_without_guessing_contract(self):
        catalogs = Catalogs()
        catalogs.vehicles = [
            {"Государственный номер": "X934AH198", "Тип владения": "Аренда", "Примечание": "№1 от01.01.2026 ИНН 7701234567"},
            {"Государственный номер": "Х934АН198", "Тип владения": "Аренда", "Примечание": "№2 от02.02.2026 ИНН 7701234567"},
        ]
        vehicle = catalogs.vehicle("Х934АН198")
        self.assertEqual(vehicle["Тип владения"], "Аренда")
        self.assertTrue(vehicle["_contract_ambiguous"])
        generator = Generator(Path(__file__).parent / "resources", catalogs)
        context = generator.context({"_container": "UETU5488899", "Номер автомашины": "Х934АН198", "Номер прицепа": "ВР615678"}, date(2026, 10, 13), "Иванов Иван Иванович")
        self.assertTrue(context["truck_contract_ambiguous"])
        root = ET.fromstring(generator.etrn(context)[1])
        self.assertEqual(root.find(".//СвТС/ТС").get("ТипВлад"), "3")
        self.assertEqual(root.find(".//СвТС/Прицеп").get("ТипВлад"), "3")
        self.assertIsNone(root.find(".//СвТС/ТС/ОснАрЛиз"))

    def test_conflicting_vehicle_ownership_never_defaults_to_property(self):
        catalogs = Catalogs()
        catalogs.vehicles = [
            {"Государственный номер": "X934AH198", "Тип владения": "Аренда"},
            {"Государственный номер": "Х934АН198", "Тип владения": "Собственность"},
        ]
        self.assertIsNone(catalogs.vehicle("Х934АН198"))
        generator = Generator(Path(__file__).parent / "resources", catalogs)
        context = generator.context({"_container": "UETU5488899", "Номер автомашины": "Х934АН198"}, date(2026, 10, 13), "Иванов Иван Иванович")
        with self.assertRaisesRegex(ValueError, "не указан подтверждённый тип владения"):
            generator.etrn(context)

    def test_forwarding_departure_uses_tms_planned_date(self):
        generator = Generator(Path(__file__).parent / "resources", Catalogs())
        context = generator.context({"_container": "NEPU4547487", "Плановая дата отправления": "2026-11-13T08:00:00"}, date(2026, 11, 12), "Иванов Иван Иванович")
        self.assertEqual(context["planned_departure_datetime"], datetime(2026, 11, 13, 8, 0))

    def test_transport_mode_follows_ttn_unit_types(self):
        self.assertEqual(transport_mode_from_ttn({"Типы грузовых единиц": "1x40HC"}), "container")
        self.assertEqual(transport_mode_from_ttn({"Типы грузовых единиц": "1xТент 120 м3"}), "non_container")
        self.assertEqual(body_type_from_ttn({"Типы грузовых единиц": "1xТент 120 м3"}), "Тент")
        self.assertIsNone(transport_mode_from_ttn({"Типы грузовых единиц": "1x40HC, 1xТент"}))

    def test_non_container_documents_use_cargo_name_only(self):
        catalogs = Catalogs()
        generator = Generator(Path(__file__).parent / "resources", catalogs)
        context = generator.context({"_container": "12345", "Клиент": "Тестовый клиент", "Исполнитель": "Тестовый перевозчик"}, date(2026, 10, 16), "Иванов Иван Иванович")
        context.update(transport_mode="non_container", cargo_name="Стальные изделия", body_type="Тент")
        for content in (generator.etrn(context)[1], generator.ezz(context)[1]):
            root = ET.fromstring(content)
            cargo = root.find(".//ОпГруз")
            self.assertEqual(cargo.get("НаимГруз"), "Стальные изделия")
            self.assertIsNone(cargo.find("СвКонтейн"))
            self.assertNotIn("Контейнер", ET.tostring(root, encoding="unicode"))

    def test_non_container_forwarding_order_omits_container_structure(self):
        company = {"name": "Тест", "inn": "7700000000", "kpp": "770001001", "address": "г. Москва"}
        context = {"planned_departure_datetime": date(2026, 10, 16), "transport_mode": "non_container", "body_type": "Тент", "container": "12345", "cargo_name": "Стальные изделия", "weight": "1000", "consignee": company, "loading": "г. Москва", "delivery": "г. Тверь", "client": company, "client_edo": "client-edo", "client_contract": {"title": "Договор", "number": "1", "date": "2026-10-01"}, "order_date": "16.10.2026", "order_number": "12345"}
        xml = ServerGenerator.forwarding_order_userdata(context, "Иванов Иван Иванович")
        root = ET.fromstring(xml)
        self.assertEqual(root.find(".//TransportInfo").get("BodyType"), "Тент")
        self.assertEqual(root.find(".//CargoInfo").get("TransportationIndicator"), "0")
        self.assertEqual(root.find(".//ItemDescription").get("Name"), "Стальные изделия")
        self.assertIsNone(root.find(".//TransportContainer"))
        self.assertEqual(root.findtext(".//ItemDescription/Marks/Mark"), "Стальные изделия")
        self.assertEqual([child.tag for child in root.find(".//ItemDescription")], ["Marks", "CargoOriginCountryInfo", "CargoWeight"])
        self.assertNotIn("Контейнер", xml)

    def test_missing_loading_point_owner_prompts_for_blank_manual_fields(self):
        catalogs = Catalogs()
        catalogs.points = [{
            "Название": "Ростов-Западный", "Номер склада и название": "510401 Ростов-Западный",
            "Адрес на русском языке": "Ростов-на-Дону, улица Мадояна, 316", "ИНН": "",
        }]
        generator = ServerGenerator(Path(__file__).parent / "resources", catalogs)
        context = generator.context({
            "_container": "TEMU7742835", "Маршрут": "(RU) Ростов-Западный -> (RU) Склад Росшина",
            "Клиент": "Тестовый клиент", "Исполнитель": "Тестовый перевозчик",
        }, date(2026, 10, 6), "Иванов Иван Иванович")
        self.assertEqual(context["loading_owner"]["name"], "")
        self.assertEqual(context["loading_owner"]["inn"], "")
        self.assertEqual(context["loading_owner"]["address"], "")
        fields, _ = prepare_manual_fields(context, "cargo")
        ids = {field["id"] for field in fields}
        self.assertTrue({"loading_owner.name", "loading_owner.inn", "loading_owner.address", "loading_owner.phone"} <= ids)
        self.assertTrue(any("Заполните пустые поля владельца" in item for item in generator.warnings(context)))
        _, content = Generator(Path(__file__).parent / "resources", catalogs).etrn(context)
        self.assertIsNone(ET.fromstring(content).find(".//СвПогруз/ВладИнфр"))

    def test_etrn_prefers_named_consignee_card_and_ip_carrier(self):
        catalogs = Catalogs()
        catalogs.companies = [
            {"Наименование": 'ООО "РОСШИНА-ИНВЕСТ (По поручению ООО «Тяговая сила»',
             "Краткое наименование": 'ОООО "РОСШИНА-ИНВЕСТ (По поручению ООО «Тяговая сила»',
             "ИНН": "2312229583", "КПП": "231101001", "Юридический адрес": "Краснодарский край, г. Краснодар"},
            {"Наименование": "РОСШИНА-ИНВЕСТ ООО г.Краснодар ИНН2312229583",
             "ИНН": "", "КПП": "231101001", "Юридический адрес": "350056, Краснодарский край, г. Краснодар, ул. Пискижева, д. 48"},
            {"Наименование": "Токарев Сергей Владимирович ИП", "Краткое наименование": "ИП Токарев",
             "ИНН": "614314841879", "Юридический адрес": "346880, Ростовская обл, г. Батайск"},
        ]
        generator = Generator(Path(__file__).parent / "resources", catalogs)
        context = generator.context({
            "_container": "TEMU7742835", "Клиент": 'ООО "РОСШИНА-ИНВЕСТ"',
            "Грузополучатель": "РОСШИНА-ИНВЕСТ ООО г.Краснодар ИНН2312229583",
            "Исполнитель": "Токарев Сергей Владимирович ИП",
        }, date(2026, 10, 6), "Иванов Иван Иванович")
        self.assertEqual(context["consignee"]["inn"], "2312229583")
        self.assertTrue(context["consignee"]["address"].startswith("350056"))
        for empty in (False, True):
            _, content = generator.etrn(context, empty=empty)
            root = ET.fromstring(content)
            carrier = root.find(".//СвПер/ИдСв/СвИП")
            self.assertEqual(carrier.get("ИННФЛ"), "614314841879")
            self.assertEqual(carrier.find("ФИО").attrib, {"Фамилия": "Токарев", "Имя": "Сергей", "Отчество": "Владимирович"})
            self.assertIsNone(root.find(".//СвПер/ИдСв/СвЮЛУч"))
            if not empty:
                consignee = root.find(".//СвГП/РекИдентГП/ИдСв/СвЮЛУч")
                self.assertEqual(consignee.get("ИННЮЛ"), "2312229583")
                self.assertIn("г.Краснодар", consignee.get("НаимОрг"))
                self.assertEqual(root.find(".//СвГП//Адрес/АдрРФ").get("Индекс"), "350056")

    def test_forwarding_container_tare_comes_from_ttn_unit_type(self):
        self.assertEqual(container_iso_from_ttn({"Типы грузовых единиц": "1x40HC"}, "ABCU1234567"), "40HC")
        self.assertEqual(container_tare_from_ttn({"Типы грузовых единиц": "1x20GP"}, "ABCU1234567"), "2200")
        self.assertEqual(container_tare_from_ttn({"Типы грузовых единиц": "1x40HC"}, "ABCU1234567"), "3700")
        with self.assertRaisesRegex(ValueError, "Типы грузовых единиц"):
            container_tare_from_ttn({}, "ABCU1234567")
        with self.assertRaisesRegex(ValueError, "Типы грузовых единиц"):
            container_tare_from_ttn({"Типы грузовых единиц": "1x20GP, 1x40HC"}, "ABCU1234567")

    def test_nbi_address(self):
        attrs = address_attributes('173008, Новгородская обл, Великий Новгород г, Магистральная ул, дом № 11/13')
        self.assertEqual((attrs['Индекс'], attrs['КодРегион'], attrs['Дом']), ('173008', '53', '11/13'))
        self.assertEqual(attrs['Улица'], 'Магистральная ул')

    def test_region_not_street(self):
        attrs = address_attributes('196006, г. Санкт-Петербург, Московский пр-кт, д. 120А, стр. 1')
        self.assertEqual(attrs['КодРегион'], '78')
        self.assertEqual(attrs['Корпус'], 'стр. 1')

    def test_full_gar(self):
        for text in (TAGLEX['address'], 'СПб, Шушары, ул. Автозаводская, д. 2, лит А'):
            gar = known_gar(text)
            self.assertTrue(complete_gar(text, gar))
            wrapper = ET.Element('Адрес')
            _set_address(wrapper, text, gar=gar)
            self.assertEqual(len(wrapper.findall('АдрФИАС/Здание')), 2)
            self.assertIsNotNone(wrapper.find('АдрФИАС/ЭлУлДорСети'))

    def test_taglex_legal_address_in_order_and_both_etrn_types(self):
        generator = Generator(Path(__file__).parent / "resources", Catalogs())
        context = generator.context({
            "_container": "FESU5281584",
            "Клиент": "Тестовый клиент",
            "Исполнитель": "Тестовый перевозчик",
        }, date(2026, 9, 23), "Иванов Иван Иванович", None)
        expected_fias = "afd01ac7-f53d-4eee-91af-ab03b25a5d4a"
        for empty in (False, True):
            _, content = generator.etrn(context, empty=empty)
            root = ET.fromstring(content)
            shipper_address = root.find(".//СвГО//Адрес")
            self.assertIsNone(shipper_address.find("АдрФИАС"))
            self.assertEqual(shipper_address.find("АдрРФ").get("Индекс"), "115191")
            self.assertEqual(shipper_address.find("АдрРФ").get("Дом"), "5")
            if empty:
                self.assertEqual(root.find(".//СвГП//Адрес/АдрФИАС").get("ИдНом"), expected_fias)
        _, content = generator.ezz(context)
        root = ET.fromstring(content)
        self.assertEqual(root.find(".//СвГО/Адрес/АдрФИАС").get("ИдНом"), expected_fias)

    def test_vehicle_rental_note_fills_both_etrn_types(self):
        catalogs = Catalogs()
        catalogs.vehicles = [{
            "Государственный номер": "В512ММ98",
            "Тип владения": "Аренда",
            "Примечание": "№бн от14.01.2026 ИНН 781133069839",
            "Марка": "Скания",
        }]
        generator = Generator(Path(__file__).parent / "resources", catalogs)
        context = generator.context({"_container": "MIOU4934154", "Номер автомашины": "В512ММ98"}, date(2026, 8, 31), "Иванов Иван Иванович", None)
        for empty in (False, True):
            _, content = generator.etrn(context, empty=empty)
            root = ET.fromstring(content)
            truck = root.find(".//СвТС/ТС")
            trailer = root.find(".//СвТС/Прицеп")
            self.assertEqual(truck.get("ТипВлад"), "3")
            basis = truck.find("ОснАрЛиз")
            self.assertEqual(basis.get("НаимДок"), "Договор аренды")
            self.assertEqual(basis.get("НомерДок"), "бн")
            self.assertEqual(basis.get("ДатаДок"), "14.01.2026")
            self.assertEqual(basis.findtext("ИдРекСост/ИННФЛ"), "781133069839")
            self.assertEqual(trailer.get("ТипВлад"), "3")
            self.assertEqual(ET.tostring(trailer.find("ОснАрЛиз")), ET.tostring(basis))

    def test_vehicle_lease_uses_same_note_fields(self):
        details = vehicle_ownership_details({
            "Тип владения": "Лизинг",
            "Примечание": "Договор №Л-42 от 02.02.2026, ИНН 7701234567",
        })
        self.assertEqual(details, {
            "ownership_code": "4", "contract_title": "Договор лизинга",
            "number": "Л-42", "date": "02.02.2026", "owner_inn": "7701234567",
        })
        catalogs = Catalogs()
        catalogs.vehicles = [{"Государственный номер": "В512ММ98", "Марка": "Скания",
                              "Тип владения": "Лизинг", "Примечание": "№Л-42 от02.02.2026 ИНН 7701234567"}]
        generator = Generator(Path(__file__).parent / "resources", catalogs)
        context = generator.context({"_container": "MIOU4934154", "Номер автомашины": "В512ММ98"}, date(2026, 8, 31), "Иванов Иван Иванович", None)
        for empty in (False, True):
            _, content = generator.etrn(context, empty=empty)
            root = ET.fromstring(content)
            truck = root.find(".//СвТС/ТС")
            trailer = root.find(".//СвТС/Прицеп")
            self.assertEqual(truck.get("ТипВлад"), "4")
            self.assertEqual(truck.find("ОснАрЛиз").get("НаимДок"), "Договор лизинга")
            self.assertEqual(truck.findtext("ОснАрЛиз/ИдРекСост/ИННЮЛ"), "7701234567")
            self.assertEqual(trailer.get("ТипВлад"), "4")
            self.assertEqual(ET.tostring(trailer.find("ОснАрЛиз")), ET.tostring(truck.find("ОснАрЛиз")))

    def test_vehicle_contract_can_be_completed_in_draft(self):
        for ownership, code in (("Аренда", "3"), ("Лизинг", "4")):
            for note in ("", "№бн от14.01.2026", "№бн от31.02.2026 ИНН 781133069839"):
                with self.subTest(ownership=ownership, note=note):
                    catalogs = Catalogs()
                    catalogs.vehicles = [{"Государственный номер": "В512ММ98", "Марка": "Скания",
                                          "Тип владения": ownership, "Примечание": note}]
                    generator = Generator(Path(__file__).parent / "resources", catalogs)
                    context = generator.context({"_container": "MIOU4934154", "Номер автомашины": "В512ММ98"},
                                                date(2026, 8, 31), "Иванов Иван Иванович", None)
                    for empty in (False, True):
                        _, content = generator.etrn(context, empty=empty)
                        root = ET.fromstring(content)
                        truck = root.find(".//СвТС/ТС")
                        trailer = root.find(".//СвТС/Прицеп")
                        self.assertEqual(truck.get("ТипВлад"), code)
                        self.assertIsNone(truck.find("ОснАрЛиз"))
                        self.assertEqual(trailer.get("ТипВлад"), code)
                        self.assertIsNone(trailer.find("ОснАрЛиз"))
                        with self.assertRaisesRegex(ValueError, "номер и дата договора аренды или лизинга"):
                            ServerGenerator._validate(context, empty=empty)
                        self.assertTrue(any("заполните недостающие реквизиты договора" in warning
                                            for warning in ServerGenerator.warnings(context, empty=empty)))
                    self.assertFalse(any("заполните недостающие реквизиты договора" in warning
                                         for warning in ServerGenerator.warnings(context, ezz=True)))
        self.assertIsNone(vehicle_ownership_details({"Тип владения": "Собственность", "Примечание": ""}))

    def test_incomplete_gar_fallback(self):
        text = '173008, Новгородская обл, Великий Новгород г, Магистральная ул, дом № 11/13'
        wrapper = ET.Element('Адрес')
        _set_address(wrapper, text, gar={'FiasId': 'incomplete', 'RegionCode': '53'})
        self.assertEqual(wrapper.find('АдрРФ').get('Дом'), '11/13')

    def test_selected_edo_kpp_only(self):
        catalogs = Catalogs()
        catalogs.edo = [{'ИНН': '5321027613', 'КПП': '532101001', 'Идентификатор участника ЭДО': 'selected'}]
        self.assertEqual(catalogs.kpp_for_edo('5321027613', 'selected'), '532101001')
        self.assertEqual(catalogs.kpp_for_edo('5321027613', ''), '')
        generator = Generator(Path(__file__).parent / 'resources', catalogs)
        ctx = {'carrier': {'inn': '5321027613', 'kpp': ''}, 'carrier_edo': 'selected'}
        generator.fill_missing_kpp(ctx)
        self.assertEqual(ctx['carrier']['kpp'], '532101001')
        ctx['carrier']['kpp'] = '123456789'
        generator.fill_missing_kpp(ctx)
        self.assertEqual(ctx['carrier']['kpp'], '123456789')
        catalogs.edo.append({**catalogs.edo[0], 'КПП': '987654321'})
        self.assertEqual(catalogs.kpp_for_edo('5321027613', 'selected'), '')

    def test_contract_parties_are_replaced(self):
        customer = ET.fromstring(
            '<СвЗак><ДогУслПер><ИдРекСост><ИННЮЛ>5047295775</ИННЮЛ></ИдРекСост></ДогУслПер></СвЗак>'
        )
        _set_contract(
            customer,
            {'title': 'Договор', 'number': 'KC&TAGLEX', 'date': '2024-08-01'},
            (TAGLEX['inn'], '7709222373'),
        )
        contract = customer.find('ДогУслПер')
        self.assertEqual(contract.get('НомерДок'), 'KC&TAGLEX')
        self.assertEqual(contract.get('ДатаДок'), '01.08.2024')
        self.assertEqual(
            [item.text for item in contract.findall('ИдРекСост/ИННЮЛ')],
            ['7734515704', '7709222373'],
        )

    def test_cargo_packaging_rules(self):
        self.assertEqual(cargo_packaging({"name": 'ООО "СК Трейд"'}), ("короба", "00"))
        self.assertEqual(cargo_packaging({"name": 'ООО "Другой клиент"'}), ("-", "00"))

    def test_vehicle_numbers_remove_slashes_and_spaces(self):
        self.assertEqual(normalize_vehicle_number("НС819/ 53"), "НС81953")
        self.assertEqual(normalize_vehicle_number("АВ 12 / 34"), "АВ1234")

        generator = Generator(Path(__file__).parent / "resources", Catalogs())
        context = generator.context({
            "_container": "TEST1234567",
            "Клиент": "Тестовый клиент",
            "Исполнитель": "Тестовый перевозчик",
            "Номер автомашины": "НС819/ 53",
            "Номер прицепа": "АВ 12 / 34",
        }, date(2026, 9, 21), "Иванов Иван Иванович", None)
        self.assertEqual(context["truck_number"], "НС81953")
        self.assertEqual(context["trailer"], "АВ1234")

    def test_late_etrn_uses_transport_date_in_number(self):
        generator = Generator(Path(__file__).parent / "resources", Catalogs())
        context = generator.context({
            "_container": "FESU5281584",
            "Клиент": "Тестовый клиент",
            "Исполнитель": "Тестовый перевозчик",
            "Плановая дата отправления": "21.09.2026 10:00",
        }, date(2026, 9, 25), "Иванов Иван Иванович", None)
        _, content = generator.etrn(context)
        root = ET.fromstring(content)
        info = root.find(".//СодИнфГО")
        self.assertEqual(info.get("НомерТрН"), "20260921-FESU5281584-CARGO")
        self.assertEqual(info.get("ДатаТрН"), "21.09.2026")

    def test_known_reference_fallbacks(self):
        self.assertEqual(known_point_phone({"Название": "Силикатная"}), "+74991879088")
        self.assertEqual(known_point_phone({"Название": "ТК Усады"}), "+74955653350")
        self.assertEqual(known_point_phone({"Название": "ООО Логистический парк Янино"}), "+78123343757")
        self.assertEqual(known_point_phone({"Название": "Пепси Янино (ПровеГрупп)"}), "")
        self.assertEqual(party({"Наименование": 'ООО "ТЛК КЕДР"'})["phone"], "+73433790858")
        tander = party({"Наименование": 'АО "ТАНДЕР"'})
        self.assertEqual(tander["inn"], "2310031475")
        self.assertEqual(tander["phone"], "+78612774654")
        self.assertTrue(tander["address"].startswith("350072"))
        ags = party({"Наименование": 'ООО "АГС"', "ИНН": "7814858496"})
        self.assertEqual(ags["phone"], "+79033478593")
        self.assertEqual(ags["kpp"], "781401001")
        self.assertEqual(
            address_attributes(ags["address"]),
            {
                "Индекс": "197701",
                "Дом": "20",
                "Корпус": "стр. 1",
                "КодРегион": "78",
                "Город": "Сестрорецк",
                "Улица": "Левашовское шоссе",
            },
        )

    def test_ags_delivery_details_reach_etrn(self):
        catalogs = Catalogs()
        catalogs.companies = [{
            "Наименование": 'ООО "АГС"',
            "ИНН": "7814858496",
            "КПП": "781401001",
            "Телефон": "",
            "Юридический адрес": "",
        }]
        catalogs.points = [{
            "Номер склада и название": "ООО «АГС»",
            "Название": "ООО «АГС»",
            "ИНН": "7814858496",
            "Номер телефона": "",
            "Адрес на русском языке": "",
        }]
        generator = Generator(Path(__file__).parent / "resources", catalogs)
        for container in ("YYCU6045148", "ZONU8246681"):
            context = generator.context({
                "_container": container,
                "Клиент": 'ООО "АГРЛ"',
                "Исполнитель": "Тестовый перевозчик",
                "Маршрут": "(RU) АО ПКТ (Первый контейнерный терминал) -> (RU) ООО «АГС»",
                "Место отправления": "(RU) АО ПКТ (Первый контейнерный терминал)",
                "Место прибытия": "(RU) ООО «АГС»",
            }, date(2026, 9, 21), "Иванов Иван Иванович", None)
            self.assertEqual(context["consignee"]["phone"], "+79033478593")
            self.assertEqual(context["delivery_owner"]["phone"], "+79033478593")
            self.assertEqual(context["delivery"], "197701, Санкт-Петербург, г. Сестрорецк, Левашовское шоссе, д. 20, стр. 1")
            _, content = generator.etrn(context)
            root = ET.fromstring(content)
            ags_parties = [
                node for node in root.findall(".//СвЮЛУч")
                if node.get("ИННЮЛ") == "7814858496"
            ]
            self.assertTrue(ags_parties)
            self.assertIn("+79033478593", [node.text for node in root.findall(".//Контакт/Тлф")])
            addresses = root.findall(".//АдрРФ") + root.findall(".//АдресРФ")
            self.assertTrue(any(node.get("Индекс") == "197701" and node.get("КодРегион") == "78" for node in addresses))

    def test_ags_route_fallback_without_route_point_catalog(self):
        catalogs = Catalogs()
        catalogs.companies = [{
            "Наименование": 'ООО "АГС"',
            "ИНН": "7814858496",
            "КПП": "781401001",
        }]
        generator = Generator(Path(__file__).parent / "resources", catalogs)
        context = generator.context({
            "_container": "SLLU5118861",
            "Клиент": 'ООО "АГРЛ"',
            "Исполнитель": "Тестовый перевозчик",
            "Маршрут": "(RU) Бронка (ООО Феникс) -> (RU) ООО «АГС»",
            "Место прибытия": "(RU) ООО «АГС»",
        }, date(2026, 9, 21), "Иванов Иван Иванович", None)
        expected = "197701, Санкт-Петербург, г. Сестрорецк, Левашовское шоссе, д. 20, стр. 1"
        self.assertEqual(context["delivery"], expected)
        self.assertTrue(context["delivery_point_found"])
        _, cargo_content = generator.etrn(context)
        cargo_root = ET.fromstring(cargo_content)
        cargo_delivery = cargo_root.find(".//СвГП/АдресДостГр/АдресРФ")
        self.assertEqual(cargo_delivery.get("Индекс"), "197701")
        self.assertEqual(cargo_delivery.get("КодРегион"), "78")
        self.assertEqual(cargo_delivery.get("Город"), "Сестрорецк")
        _, empty_content = generator.etrn(context, empty=True)
        empty_root = ET.fromstring(empty_content)
        empty_loading = empty_root.find(".//СвПогруз/ФАдресПогр/АдресРФ")
        self.assertEqual(empty_loading.get("Индекс"), "197701")
        self.assertEqual(empty_loading.get("КодРегион"), "78")
        self.assertEqual(empty_loading.get("Город"), "Сестрорецк")

    def test_specific_route_endpoint_wins_for_cimu3116264(self):
        catalogs = Catalogs()
        catalogs.points = [
            {
                "Номер склада и название": 'ООО "ЦТ"',
                "Название": 'ООО "ЦТ"',
                "ИНН": "5031155564",
                "Адрес": "Носовихинское шоссе, 26-й километр, 1, Электроугли",
            },
            {
                "Номер склада и название": "Новомосковск",
                "Название": "Новомосковск",
                "Адрес": "Россия, Маклец, Тульская обл., Россия, 301692",
            },
            {
                "Номер склада и название": "Новомосковск P&G",
                "Название": "Новомосковск P&G",
                "Адрес": "301654, обл. Тульская, р-н. Новомосковский, г. Новомосковск, ш. Комсомольское, дом 64",
            },
        ]
        generator = Generator(Path(__file__).parent / "resources", catalogs)
        context = generator.context({
            "_container": "CIMU3116264",
            "Клиент": 'ООО "ПРОКТЕР ЭНД ГЭМБЛ-НОВОМОСКОВСК"',
            "Исполнитель": 'ООО "АКСС ПЛЮС"',
            "Грузополучатель": 'ООО "ПРОКТЕР ЭНД ГЭМБЛ-НОВОМОСКОВСК"',
            "Маршрут": '(RU) ООО "ЦТ" -> (RU) Новомосковск P&G',
            "Место забора груза (Маршрут)": '(RU) ООО "ЦТ"',
            "Место доставки груза (Маршрут)": "Новомосковск",
        }, date(2026, 9, 21), "Алексеев Михаил Геннадьевич", None)
        self.assertEqual(
            context["loading"],
            "142461, Московская область, городской округ Богородский, г. Электроугли, территория Носовихинское шоссе, 26-й километр, д. 1",
        )
        self.assertEqual(
            context["delivery"],
            "301654, обл. Тульская, р-н. Новомосковский, г. Новомосковск, ш. Комсомольское, дом 64",
        )
        _, content = generator.etrn(context)
        root = ET.fromstring(content)
        loading = root.find(".//СвПогруз/ФАдресПогр/АдресРФ")
        delivery = root.find(".//СвГП/АдресДостГр/АдресРФ")
        self.assertEqual((loading.get("Индекс"), loading.get("Дом")), ("142461", "1"))
        self.assertEqual(loading.get("Город"), "Электроугли")
        self.assertIn("26-й километр", loading.get("Улица"))
        self.assertEqual(
            (delivery.get("Индекс"), delivery.get("Район"), delivery.get("Город"), delivery.get("Дом")),
            ("301654", "Новомосковский", "Новомосковск", "64"),
        )
        self.assertIn("Комсомольское", delivery.get("Улица"))

        _, order_content = generator.ezz(context)
        order_root = ET.fromstring(order_content)
        submission = order_root.find(".//ПунктПод/АдрПунктПод/Адрес/АдрРФ")
        order_points = order_root.findall(".//АдрПункт/АдресПункт/Адрес/АдрРФ")
        self.assertEqual((submission.get("Индекс"), submission.get("Город"), submission.get("Дом")), ("142461", "Электроугли", "1"))
        self.assertEqual((order_points[0].get("Индекс"), order_points[0].get("Город"), order_points[0].get("Дом")), ("142461", "Электроугли", "1"))
        self.assertEqual(
            (order_points[1].get("Индекс"), order_points[1].get("Район"), order_points[1].get("Город"), order_points[1].get("Дом")),
            ("301654", "Новомосковский", "Новомосковск", "64"),
        )
        self.assertIn("Комсомольское", order_points[1].get("Улица"))
        self.assertNotIn("Маклец", ET.tostring(order_root, encoding="unicode"))

    def test_yanino_loading_owner_phone_reaches_etrn(self):
        catalogs = Catalogs()
        catalogs.points = [{
            "Номер склада и название": "ООО Логистический парк Янино",
            "Название": "ООО Логистический парк Янино",
            "ИНН": "7813173683",
            "Номер телефона": "",
            "Адрес на русском языке": "188689, Ленинградская область, Янино-1, Логистический въезд, здание 5",
        }]
        generator = Generator(Path(__file__).parent / "resources", catalogs)
        context = generator.context({
            "_container": "TEST1234567",
            "Клиент": "Тестовый клиент",
            "Исполнитель": "Тестовый перевозчик",
            "Маршрут": "(RU) ООО Логистический парк Янино -> (RU) Склад доставки",
        }, date(2026, 9, 17), "Иванов Иван Иванович", None)
        self.assertEqual(context["loading_owner"]["phone"], "+78123343757")
        _, content = generator.etrn(context)
        root = ET.fromstring(content)
        self.assertEqual(root.findtext(".//СвПогруз/ВладИнфр//Контакт/Тлф"), "+78123343757")

    def test_empty_etrn_uses_container_stock_point_and_inn(self):
        catalogs = Catalogs()
        stock = {
            "Номер склада и название": "Терминал Волхонский М11 ИНН 9705100811",
            "Название": "Терминал Волхонский М11 ИНН 9705100811",
            "Роли": "Контейнерный сток",
            "ИНН": "9705100811",
            "Адрес на русском языке": "г. Санкт-Петербург, Волхонское шоссе, 6",
        }
        catalogs.points = [stock]
        generator = Generator(Path(__file__).parent / "resources", catalogs)
        context = generator.context({
            "_container": "SLLU5118861",
            "Клиент": 'ООО "АГРЛ"',
            "Исполнитель": "Тестовый перевозчик",
            "Маршрут": "(RU) Бронка (ООО Феникс) -> (RU) ООО «АГС»",
            "Инструкция на сдачу порожнего": 'Терминал "Волхонский М11", Адрес: неверный адрес',
        }, date(2026, 9, 2), "Иванов Иван Иванович", stock)
        self.assertEqual(context["stock_party"]["inn"], "9705100811")
        self.assertEqual(context["stock_party"]["name"], 'ООО "КОНТВЭЛЛ"')
        self.assertEqual(context["stock_party"]["kpp"], "772501001")
        self.assertEqual(context["stock_party"]["phone"], "+78126039299")
        _, content = generator.etrn(context, empty=True)
        root = ET.fromstring(content)
        consignee = root.find(".//СвГП//СвЮЛУч")
        self.assertEqual(consignee.get("ИННЮЛ"), TAGLEX["inn"])
        self.assertEqual(consignee.get("КПП"), TAGLEX["kpp"])
        self.assertEqual(consignee.get("НаимОрг"), TAGLEX["name"])
        self.assertEqual(root.findtext(".//СвГП//Контакт/Тлф"), TAGLEX["phone"])
        self.assertNotIn("КОНТВЭЛЛ", ET.tostring(root, encoding="unicode"))
        address = root.find(".//СвГП/АдресДостГр/АдресРФ")
        self.assertEqual(address.get("Индекс"), "198323")
        self.assertEqual(address.get("КодРегион"), "78")
        self.assertIn("Волхонское шоссе", address.get("Улица"))
        self.assertEqual(address.get("Дом"), "6")
        self.assertNotIn("неверный адрес", ET.tostring(root, encoding="unicode"))

    def test_forwarding_order_uses_valid_container_structure_and_services(self):
        party_data = {
            "name": 'ООО "Тест"',
            "inn": "7700000000",
            "kpp": "770001001",
            "address": "г. Москва",
        }
        context = {
            "planned_departure_datetime": date(2026, 9, 15),
            "container": "XYZU4002173",
            "container_provider": "2",
            "weight": "1000",
            "cargo_name": "Груз",
            "shipper": party_data,
            "consignee": party_data,
            "loading": "г. Москва",
            "delivery": "г. Санкт-Петербург",
            "services": ["Организация перевозки", "Погрузочные" + chr(0xDC98) + " работы"],
            "seals": "123456, ABC-7",
            "seal_numbers": ["123456", "ABC-7"],
            "cargo_name": "Абсорбент",
            "order_shipper": {"name": "Shandong Nuoer Biological Technology Co.", "foreign": True},
            "client": party_data,
            "client_edo": "client-edo",
            "client_contract": {"title": "Договор", "number": "1", "date": "2026-09-01"},
            "order_date": "15.09.2026",
            "order_number": "28384",
        }
        xml = ServerGenerator.forwarding_order_userdata([context], "Иванов Иван Иванович")
        self.assertNotIn(chr(0xDC98), xml)
        root = ET.fromstring(xml)
        self.assertIsNone(root.find(".//ItemDescription/CargoNumbers"))
        self.assertEqual(root.find(".//CargoInfo").get("ReadyFromDate"), "15.09.2026")
        self.assertEqual(root.find(".//CargoInfo").get("ReadyToDate"), "15.09.2026")
        self.assertEqual(root.findtext(".//CargoOriginCountryInfo/Country"), "643")
        container = root.find(".//TransportContainer")
        self.assertEqual(container.get("ContainerOrderNumber"), "1")
        self.assertEqual(container.get("IsContainerProvided"), "2")
        self.assertIsNone(container.get("ContainerTareWeight"))
        self.assertEqual(container.get("TotalGrossWeight"), "1000")
        self.assertEqual(container.get("SealCount"), "1")
        self.assertEqual(container.findtext("IntContainerId"), "XYZU4002173")
        self.assertEqual(container.findtext("SealNumbers/SealNumber"), "123456")
        self.assertEqual(root.find(".//Shipper/OrganizationDetails").get("OrgType"), "4")
        self.assertEqual(root.find(".//Shipper/OrganizationDetails").get("StatusId"), "LegalEntity")
        self.assertEqual(root.find(".//ItemDescription").get("Name"), "Абсорбент")
        self.assertEqual(root.find(".//ForwarderInfo/OrganizationDetails/Address/RussianAddress").get("OtherInfo"), TAGLEX["address"])
        self.assertEqual(
            [node.get("ServiceName") for node in root.findall(".//LogisticsServiceInfo")],
            ["Организация перевозки", "Погрузочные работы"],
        )
        self.assertIsNotNone(root.find(".//DestinationAddress/CargoDeliveryAddress/Address"))
        context["container_provider"] = "1"
        with self.assertRaisesRegex(ValueError, "массу тары"):
            ServerGenerator.forwarding_order_userdata([context], "Иванов Иван Иванович")
        context["container_tare"] = "3700"
        with_tare = ET.fromstring(ServerGenerator.forwarding_order_userdata([context], "Иванов Иван Иванович"))
        self.assertEqual(with_tare.find(".//TransportContainer").get("ContainerTareWeight"), "3700")
        context.pop("container_provider")
        with self.assertRaisesRegex(ValueError, "кто предоставил контейнер"):
            ServerGenerator.forwarding_order_userdata([context], "Иванов Иван Иванович")

    def test_forwarding_order_can_use_taglex_as_client_and_carrier_as_forwarder(self):
        carrier = {"name": 'ООО "Перевозчик"', "inn": "7700000000", "kpp": "770001001", "address": "г. Москва"}
        context = {
            "planned_departure_datetime": date(2026, 9, 15),
            "container": "XYZU4002173", "container_provider": "1", "container_iso": "40HC", "container_tare": "3700", "weight": "1000", "cargo_name": "Груз",
            "consignee": carrier, "loading": "г. Москва", "delivery": "г. Санкт-Петербург", "cargo_route": "Москва -> Санкт-Петербург",
            "forwarding_delivery_datetime": datetime(2026, 9, 22, 20, 0),
            "services": ["Организация автодоставки", "Перетарка"],
            "client": carrier, "client_edo": "old-client-id",
            "carrier": carrier, "carrier_edo": "carrier-id",
            "carrier_contract": {"title": "Договор экспедиции", "number": "42", "date": "2026-09-01"},
            "order_date": "15.09.2026", "order_number": "XYZU4002173",
        }
        root = ET.fromstring(ServerGenerator.forwarding_order_userdata(context, "Иванов Иван Иванович", "taglex_to_carrier"))
        self.assertEqual(root.find(".//ClientInfo/OrganizationDetails").get("Inn"), TAGLEX["inn"])
        self.assertEqual(root.find(".//Shipper/OrganizationDetails").get("Inn"), TAGLEX["inn"])
        self.assertEqual(root.find(".//ForwarderInfo/OrganizationDetails").get("Inn"), carrier["inn"])
        self.assertEqual(root.find(".//ForwardingContractRequisites").get("DocumentNumber"), "42")
        self.assertEqual(root.find(".//CargoInfo").get("AcceptReq"), "1")
        self.assertEqual(root.find(".//CargoInfo").get("CargoRoute"), "Москва -> Санкт-Петербург")
        self.assertEqual(root.find(".//CargoInfo").get("DeliveryFromDate"), "22.09.2026")
        self.assertEqual(root.find(".//CargoInfo").get("DeliveryToDate"), "22.09.2026")
        self.assertEqual(root.find(".//CargoInfo").get("DeliveryTime"), "20:00-20:00+03:00")
        self.assertEqual(root.find(".//ClientDirectives").get("TransportationDirectives"), "нет")
        self.assertEqual(root.find(".//ClientDirectives").get("SpecialInformation"), "нет")
        self.assertIsNotNone(root.find(".//ClientDirectives/ClimateTransportRegime"))
        self.assertEqual(root.find(".//TransportContainer").get("IsContainerProvided"), "1")
        self.assertEqual(root.find(".//TransportContainer").get("ISOContainer"), "40HC")
        self.assertEqual(root.find(".//TransportContainer").get("ContainerTareWeight"), "3700")
        self.assertEqual([item.get("ServiceName") for item in root.findall(".//LogisticsServiceInfo")], ["Организация автодоставки", "Перетарка"])

    def test_forwarding_order_uses_preferred_carrier_edo_id(self):
        catalogs = Catalogs()
        carrier = {"name": 'ООО "РУСКОМ"', "inn": "2315161125", "kpp": "231501001"}
        catalogs.edo = [
            {"ИНН": carrier["inn"], "КПП": carrier["kpp"], "Идентификатор участника ЭДО": "2AE-first"},
            {"ИНН": carrier["inn"], "КПП": carrier["kpp"], "Идентификатор участника ЭДО": "2AE-selected"},
        ]
        self.assertEqual(catalogs.preferred_edo_id(carrier, {}), "")
        selected = catalogs.preferred_edo_id(carrier, {
            "2315161125|231501001": {"participantId": "2AE-selected"}
        })
        self.assertEqual(selected, "2AE-selected")
        with self.assertRaisesRegex(ValueError, "больше не найден"):
            catalogs.preferred_edo_id(carrier, {
                "2315161125|231501001": {"participantId": "2AE-outdated"}
            })

    def test_forwarding_route_prefers_dedicated_tms_fields(self):
        generator = ServerGenerator(Path(__file__).parent / "resources", Catalogs())
        context = generator.context({
            "_container": "TEST1234567",
            "Клиент": "Тестовый клиент",
            "Исполнитель": "Тестовый перевозчик",
            "Место забора груза (Маршрут)": "Склад отправления",
            "Место доставки груза (Маршрут)": "Склад доставки",
            "Маршрут": "Неверное начало -> Неверный конец",
        }, date(2026, 9, 15), "Тест", None)
        self.assertIn("Склад отправления", context["loading"])
        self.assertIn("Склад доставки", context["delivery"])


if __name__ == '__main__':
    unittest.main()
