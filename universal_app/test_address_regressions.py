import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from address_xml import known_gar, complete_gar
from data_sources import Catalogs
from xml_generator import Generator, TAGLEX, address_attributes, _set_address, _set_contract


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


if __name__ == '__main__':
    unittest.main()
