import unittest
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from address_xml import known_gar, complete_gar
from data_sources import Catalogs
from xml_generator import Generator, TAGLEX, address_attributes, _set_address, _set_contract, cargo_packaging, known_point_phone, party
from server_generator import Generator as ServerGenerator


class AddressRegressions(unittest.TestCase):
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

    def test_known_reference_fallbacks(self):
        self.assertEqual(known_point_phone({"Название": "Силикатная"}), "+74991879088")
        self.assertEqual(known_point_phone({"Название": "ТК Усады"}), "+74955653350")
        self.assertEqual(party({"Наименование": 'ООО "ТЛК КЕДР"'})["phone"], "+73433790858")
        tander = party({"Наименование": 'АО "ТАНДЕР"'})
        self.assertEqual(tander["inn"], "2310031475")
        self.assertEqual(tander["phone"], "+78612774654")
        self.assertTrue(tander["address"].startswith("350072"))

    def test_forwarding_order_container_structure(self):
        party_data = {"name": "ООО Тест\udc98", "inn": "7701234567", "kpp": "770101001", "address": "101000, г. Москва, ул. Тестовая, д. 1"}
        ctx = {
            "order_number": "28384", "order_date": "11.09.2026", "container": "XYZU4002173",
            "planned_departure_datetime": datetime(2026, 9, 11), "weight": "1000",
            "client": party_data, "client_edo": "2BM-client", "consignee": party_data,
            "consignee_edo": "2BM-consignee", "loading_owner": party_data,
            "loading": party_data["address"], "delivery": party_data["address"],
            "client_contract": {"title": "Договор", "number": "1", "date": "2026-09-01"},
        }
        root = ET.fromstring(ServerGenerator.forwarding_order_userdata(ctx, "Иванов Иван Иванович"))
        self.assertNotIn("\udc98", ET.tostring(root, encoding="unicode"))
        cargo = root.find("./ClientForwarderOrder/CargoInfos/CargoInfo")
        self.assertEqual(cargo.findtext("./ItemDescriptions/ItemDescription/CargoNumbers/CargoNumber"), "1")
        self.assertEqual(cargo.findtext("./ItemDescriptions/ItemDescription/CargoOriginCountryInfo/Country"), "643")
        self.assertEqual(cargo.find("./ItemDescriptions/ItemDescription/CargoWeight").attrib, {"NetWeight": "1000", "GrossWeight": "1000"})
        container = cargo.find("./TransportContainers/TransportContainer")
        self.assertEqual(container.attrib, {"ContainerOrderNumber": "1", "IsContainerProvided": "2"})
        self.assertIsNotNone(cargo.find("DestinationAddress"))


if __name__ == '__main__':
    unittest.main()
