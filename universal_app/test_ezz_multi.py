import unittest
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from pathlib import Path

from data_sources import Catalogs
from server_generator import Generator as ServerGenerator
from xml_generator import Generator


class MultiOrderTests(unittest.TestCase):
    def setUp(self):
        resources = Path(__file__).parent / "resources"
        self.generator = Generator(resources, Catalogs())
        self.first = self.generator.context({"_container":"CICU7424162", "Клиент":"Таглекс", "Исполнитель":"Перевозчик", "Вес брутто":"9720"}, date(2026, 11, 5), "Иванов Иван Иванович")
        self.first.update(transport_mode="container", order_number="GROUP-001", weight="9720")
        self.second = {**self.first, "container":"CICU6218655", "weight":"3500"}

    def test_one_xml_contains_one_cargo_block_per_container(self):
        _, content = self.generator.ezz(self.first, [self.first, self.second])
        cargo = ET.fromstring(content).findall(".//СодИнфГО/ОпГруз")
        self.assertEqual([item.get("НаимГруз") for item in cargo], ["Контейнер CICU7424162", "Контейнер CICU6218655"])
        self.assertEqual([item.find("МасГруз").get("МасБрутЗнач") for item in cargo], ["9720", "3500"])
        self.assertEqual(ET.fromstring(content).find(".//СодИнфГО").get("НомЗак"), "GROUP-001")

    def test_server_generator_accepts_different_unloading_dates(self):
        self.first["carrier"]["inn"] = "7700000000"
        self.first["client"]["inn"] = "7734515704"
        self.first["carrier_edo"] = "carrier-box"
        self.first["client_edo"] = "client-box"
        self.second["carrier_edo"] = "carrier-box"
        self.second["client_edo"] = "client-box"
        self.second["planned_arrival_datetime"] += timedelta(days=1)
        _, content = ServerGenerator(Path(__file__).parent / "resources", Catalogs()).ezz_multi([self.first, self.second])
        self.assertEqual(len(ET.fromstring(content).findall(".//СодИнфГО/ОпГруз")), 2)

    def test_different_vehicle_submission_times_on_same_day_are_accepted(self):
        second = {**self.second, "planned_departure_datetime": self.first["planned_departure_datetime"] + timedelta(hours=1)}
        ServerGenerator.validate_ezz_group([self.first, second])

    def test_different_vehicle_submission_dates_are_rejected(self):
        second = {**self.second, "planned_departure_datetime": self.first["planned_departure_datetime"] + timedelta(days=1)}
        with self.assertRaisesRegex(ValueError, "дата подачи ТС"):
            ServerGenerator.validate_ezz_group([self.first, second])

    def test_route_mismatch_is_rejected(self):
        second = {**self.second, "delivery":"Другой адрес"}
        with self.assertRaisesRegex(ValueError, "маршрут и адреса"):
            ServerGenerator.validate_ezz_group([self.first, second])

    def test_weight_must_be_positive(self):
        second = {**self.second, "weight":"0"}
        with self.assertRaisesRegex(ValueError, "больше нуля"):
            ServerGenerator.validate_ezz_group([self.first, second])


if __name__ == "__main__":
    unittest.main()
