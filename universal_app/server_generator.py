from pathlib import Path
import re
import uuid
from decimal import Decimal, InvalidOperation
import xml.etree.ElementTree as ET

from xml_generator import Generator as BaseGenerator, TAGLEX, address_attributes, vehicle_ownership_details
from data_sources import vehicle_ownership_kind


class Generator(BaseGenerator):
    """Server-only generator without Tkinter/desktop dependencies."""

    def __init__(self, resources: Path, catalogs):
        if not (resources / "etrn_cargo_sample.xml").exists():
            resources = resources / "resources"
        super().__init__(resources, catalogs)

    @staticmethod
    def _validate(ctx, empty=False, ezz=False):
        missing = []
        if ctx.get("transport_mode") == "non_container" and not ctx.get("cargo_name"):
            missing.append("наименование груза")
        if empty and ctx.get("transport_mode") == "non_container":
            raise ValueError("ЭТрН на порожний контейнер неприменима к перевозке без контейнера")
        if not ctx["carrier"]["inn"]:
            missing.append("перевозчик")
        if not ctx["carrier_edo"]:
            missing.append("ID ЭДО перевозчика")
        if not ezz and not empty:
            if not ctx["consignee"]["inn"]:
                missing.append("грузополучатель")
            if not ctx["consignee_edo"]:
                missing.append("ID ЭДО грузополучателя")
        if not ctx["client"]["inn"]:
            missing.append("заказчик")
        if not ctx["client_edo"]:
            missing.append("ID ЭДО заказчика")
        if not ctx.get("user"):
            missing.append("сотрудник, осуществляющий погрузку")
        if not ezz and not ctx["truck_number"]:
            missing.append("автомобиль")
        if not ezz and ctx["truck_number"] and not vehicle_ownership_kind((ctx.get("truck_vehicle") or {}).get("Тип владения")):
            missing.append(f"тип владения ТС {ctx['truck_number']} в справочнике автомашин")
        if not ezz:
            ownership = vehicle_ownership_details(ctx.get("truck_vehicle") or {})
            if ownership and not all(ownership.get(field) for field in ("number", "date", "owner_inn")):
                missing.append("номер и дата договора аренды или лизинга, ИНН владельца ТС")
        if empty and not ctx["stock"]:
            missing.append("контейнерный сток")
        if empty and ctx["stock"] and not ctx.get("stock_party", {}).get("inn"):
            missing.append("ИНН контейнерного стока")
        if missing:
            raise ValueError("не заполнено: " + ", ".join(missing))

    @staticmethod
    def warnings(ctx, empty=False, ezz=False):
        warnings = []
        if ezz and (not ctx.get("loading_owner", {}).get("inn") or not ctx.get("loading_owner", {}).get("name")):
            warnings.append("В справочнике не заполнены название или ИНН владельца точки погрузки. Заполните сведения о владельце вручную в заявке перед подписанием.")
        if not ezz:
            if ctx.get("truck_number") and not vehicle_ownership_kind((ctx.get("truck_vehicle") or {}).get("Тип владения")):
                warnings.append("Тип владения тягачом не подтверждён в TMS. Укажите его вручную; для прицепа применяется тот же тип.")
            if ctx.get("truck_contract_ambiguous"):
                warnings.append("Для автомобиля найдены несколько карточек с одинаковым типом владения, но разными договорами. Тип владения сохранён; реквизиты договора нужно проверить и заполнить вручную перед подписанием.")
            ownership = vehicle_ownership_details(ctx.get("truck_vehicle") or {})
            if ownership and not all(ownership.get(field) for field in ("number", "date", "owner_inn")):
                warnings.append("Для аренды или лизинга заполните недостающие реквизиты договора: номер, дату и ИНН владельца ТС.")
            if not ctx.get("client", {}).get("phone"):
                warnings.append("В справочнике организаций не заполнен телефон заказчика.")
            if not empty and not ctx.get("consignee", {}).get("phone"):
                warnings.append("В справочнике организаций не заполнен телефон грузополучателя.")
            missing_driver = []
            if not ctx.get("driver_name"):
                missing_driver.append("ФИО")
            if not ctx.get("driver_phone"):
                missing_driver.append("телефон")
            if len("".join(ch for ch in ctx.get("driver_license", "") if ch.isalnum())) < 7:
                missing_driver.append("водительское удостоверение")
            if missing_driver:
                has_driver_data = bool(ctx.get("driver_name") or ctx.get("driver_phone") or ctx.get("driver_license"))
                ending = " Остальные сведения о водителе будут заполнены." if has_driver_data else " Раздел водителя не будет включён в ЭТрН."
                warnings.append("По водителю не заполнено: " + ", ".join(missing_driver) + "." + ending)
        if ezz and not ctx.get("carrier_contract"):
            warnings.append("Для перевозчика не найден договор в справочнике. В заявке будет указано, что договор не найден.")
        elif not ezz and not ctx.get("client_contract"):
            warnings.append("Для заказчика не найден договор в справочнике. Реквизиты договора не будут включены.")
        if not ezz:
            loading_found = ctx.get("delivery_point_found") if empty else ctx.get("loading_point_found")
            if not loading_found:
                warnings.append("Полный адрес погрузки не найден в справочнике точек маршрута.")
            if not (ctx.get("consignee") if empty else ctx.get("loading_owner")).get("inn"):
                warnings.append("В TMS не указан владелец объекта пункта погрузки. Заполните пустые поля владельца вручную перед формированием ЭТрН или проверьте их в Контуре перед подписанием.")
            if not empty and not ctx.get("loading_owner", {}).get("name"):
                warnings.append("Не указано название владельца объекта пункта погрузки.")
            if not empty and not ctx.get("loading_owner", {}).get("address"):
                warnings.append("Не указан юридический адрес владельца объекта пункта погрузки.")
            if not (ctx.get("consignee") if empty else ctx.get("loading_owner")).get("phone"):
                warnings.append("Для владельца объекта пункта погрузки не заполнен телефон в справочнике.")
            if not empty and not ctx.get("delivery_point_found"):
                warnings.append("Полный адрес доставки не найден в справочнике точек маршрута.")
        return warnings

    def etrn(self, ctx, empty=False):
        self._validate(ctx, empty=empty)
        return super().etrn(ctx, empty)

    def ezz(self, ctx):
        self._validate(ctx, ezz=True)
        return super().ezz(ctx)

    def ezz_multi(self, contexts):
        if len(contexts) < 2:
            raise ValueError("Для общей заявки выберите не менее двух контейнеров")
        for ctx in contexts:
            self._validate(ctx, ezz=True)
        self.validate_ezz_group(contexts)
        return super().ezz(contexts[0], contexts)

    @staticmethod
    def validate_ezz_group(contexts):
        fields = {
            "перевозчик": lambda c: (c["carrier"].get("inn"), c["carrier_edo"]),
            "заказчик": lambda c: (c["client"].get("inn"), c["client_edo"]),
            "маршрут и адреса": lambda c: (c["loading"], c["delivery"]),
            "дата подачи ТС": lambda c: c["planned_departure_datetime"].date(),
            "договор с перевозчиком": lambda c: c.get("carrier_contract"),
            "владелец пункта погрузки": lambda c: c.get("loading_owner"),
            "тип перевозки": lambda c: c.get("transport_mode"),
            "тип кузова": lambda c: c.get("body_type"),
            "номер заявки": lambda c: c.get("order_number"),
        }
        reference = contexts[0]
        for ctx in contexts[1:]:
            for label, value in fields.items():
                if value(ctx) != value(reference):
                    raise ValueError(f"Нельзя объединить {reference['container']} и {ctx['container']}: различается {label}.")
        for ctx in contexts:
            try:
                weight = Decimal(str(ctx.get("weight") or "").replace(" ", "").replace("\u00a0", "").replace(",", "."))
            except InvalidOperation:
                raise ValueError(f"Не указан корректный вес для {ctx['container']}") from None
            if not weight.is_finite() or weight <= 0:
                raise ValueError(f"Вес контейнера {ctx['container']} должен быть больше нуля")
            ctx["weight"] = format(weight, "f")

    @staticmethod
    def forwarding_order_userdata(contexts, signer_name, direction="client_to_taglex"):
        if isinstance(contexts, dict):
            contexts = [contexts]
        ctx = contexts[0]
        def russian_address(parent, text, include_other_info=False):
            attrs = address_attributes(text or "")
            region = attrs.get("КодРегион")
            if not region:
                return False
            mapped = {"Индекс":"ZipCode","КодРегион":"Region","Город":"City","НаселПункт":"Locality","Улица":"Street","Дом":"Building","Корпус":"Block"}
            values = {mapped[key]:value for key,value in attrs.items() if key in mapped and value}
            if include_other_info and text:
                values["OtherInfo"] = str(text)[:1000]
            ET.SubElement(parent, "RussianAddress", values)
            return True

        def org(parent, data, edo="", address_as_other_info=False):
            foreign = bool(data.get("foreign"))
            details = ET.SubElement(parent, "OrganizationDetails", {
                "OrgType":"4" if foreign else "2", "OrgName":data.get("name") or "Не указано",
                **({"Inn":data.get("inn")} if data.get("inn") and not foreign else {}),
                **({"Kpp":data.get("kpp")} if data.get("kpp") and not foreign else {}),
                **({"FnsParticipantId":edo} if edo and not foreign else {}),
                **({"StatusId":"LegalEntity","OrganizationOrPersonInfo":data.get("name") or "Не указано"} if foreign else {}),
            })
            address = ET.Element("Address")
            if russian_address(address, data.get("address") or "", address_as_other_info):
                details.append(address)

        parts = signer_name.split()
        if len(parts) < 2:
            raise ValueError("укажите фамилию и имя подписанта клиента")
        carrier_forwarder = direction == "taglex_to_carrier"
        client = TAGLEX if carrier_forwarder else ctx["client"]
        client_edo = TAGLEX["edo"] if carrier_forwarder else ctx.get("client_edo")
        forwarder = ctx["carrier"] if carrier_forwarder else TAGLEX
        forwarder_edo = ctx.get("carrier_edo") if carrier_forwarder else TAGLEX["edo"]
        contract = ctx.get("carrier_contract") if carrier_forwarder else ctx.get("client_contract")
        if not contract:
            raise ValueError("для экспедитора не найден договор транспортной экспедиции" if carrier_forwarder else "для клиента не найден договор транспортной экспедиции")
        if not client.get("inn") or not client_edo:
            raise ValueError("для клиента не заполнены ИНН или ID ЭДО")
        if carrier_forwarder and (not forwarder.get("inn") or not forwarder_edo):
            raise ValueError("для перевозчика-экспедитора не заполнены ИНН или ID ЭДО")
        root = ET.Element("LogisticsForwardingOrderClientTitle", {
            "ForwardingOrderId":str(uuid.uuid4()), "Number":ctx["order_number"], "Date":ctx["order_date"], "HasCargoDocs":"0",
        })
        order = ET.SubElement(root, "ClientForwarderOrder")
        cargo_infos = ET.SubElement(order, "CargoInfos")
        for cargo_index, cargo_ctx in enumerate(contexts, start=1):
            non_container = cargo_ctx.get("transport_mode") == "non_container"
            delivery_datetime = cargo_ctx.get("forwarding_delivery_datetime")
            delivery_time = delivery_datetime.strftime("%H:%M") if delivery_datetime else ""
            cargo = ET.SubElement(cargo_infos, "CargoInfo", {
                "ReadyFromDate":cargo_ctx["planned_departure_datetime"].strftime("%d.%m.%Y"),
                "ReadyToDate":cargo_ctx["planned_departure_datetime"].strftime("%d.%m.%Y"),
                **({"DeliveryFromDate":delivery_datetime.strftime("%d.%m.%Y"),
                    "DeliveryToDate":delivery_datetime.strftime("%d.%m.%Y"),
                    "DeliveryTime":f"{delivery_time}-{delivery_time}+03:00"} if delivery_datetime else {}),
                "TransportationIndicator":"0" if non_container else "1", "CargoBatchId":str(uuid.uuid4()), "ShipmentCargoSpaceQuantity":"1", "NotifyReq":"0",
                **({"CargoRoute":str(cargo_ctx["cargo_route"])[:1000]} if cargo_ctx.get("cargo_route") else {}),
                **({"AcceptReq":"1"} if carrier_forwarder else {}),
            })
            org(ET.SubElement(cargo,"Consignee"),cargo_ctx["consignee"],cargo_ctx.get("consignee_edo",""))
            shipper = TAGLEX if carrier_forwarder else cargo_ctx.get("order_shipper") or (cargo_ctx.get("loading_owner") if (cargo_ctx.get("loading_owner") or {}).get("inn") else cargo_ctx["client"])
            org(ET.SubElement(cargo,"Shipper"),shipper)
            if non_container and not cargo_ctx.get("cargo_name"):
                raise ValueError("для перевозки без контейнера укажите наименование груза")
            ET.SubElement(ET.SubElement(cargo,"TransportInfos"),"TransportInfo",{"TransportType":"1","BodyType":(cargo_ctx.get("body_type") or "Тент") if non_container else "Контейнеровоз"})
            directives=ET.SubElement(cargo,"ClientDirectives",{"TransportationDirectives":"нет","SpecialInformation":"нет"})
            ET.SubElement(directives,"ClimateTransportRegime")
            weight = cargo_ctx.get("weight") or "0"
            ET.SubElement(cargo,"BatchWeight",{"NetWeight":weight,"GrossWeight":weight})
            descriptions=ET.SubElement(cargo,"ItemDescriptions")
            item=ET.SubElement(descriptions,"ItemDescription",{"Name":cargo_ctx.get("cargo_name") or f"Контейнер {cargo_ctx['container']}","CargoSpaceQuantity":"1","HasDangerous":"0","HasRestrictedItems":"0","CanSpecifyVolume":"0","IsForStateSystemRegistration":"0","HasPackaging":"0","HasCommodityCode":"0"})
            ET.SubElement(ET.SubElement(item,"Marks"),"Mark").text = cargo_ctx["cargo_name"] if non_container else cargo_ctx["container"]
            origin=ET.SubElement(item,"CargoOriginCountryInfo")
            ET.SubElement(origin,"Country").text="643"
            ET.SubElement(item,"CargoWeight",{"NetWeight":weight,"GrossWeight":weight})
            if not non_container:
                containers=ET.SubElement(cargo,"TransportContainers")
                seals=[seal for seal in cargo_ctx.get("seal_numbers",[]) if re.fullmatch(r"\d{1,10}",str(seal))]
                container_attrs={"ContainerOrderNumber":str(cargo_index),"TotalGrossWeight":weight,**({"SealCount":str(len(seals))} if seals else {})}
                iso_container=str(cargo_ctx.get("container_iso") or "").strip().upper()
                if iso_container:
                    if not re.fullmatch(r"(?:20|40)[A-Z]{2}",iso_container):
                        raise ValueError(f"некорректный ISO-тип контейнера {cargo_ctx['container']}: {iso_container}")
                    container_attrs["ISOContainer"]=iso_container
                provider=str(cargo_ctx.get("container_provider") or "").strip()
                tare=str(cargo_ctx.get("container_tare") or "").strip().replace(",", ".")
                if provider not in {"1", "2"}:
                    raise ValueError(f"для контейнера {cargo_ctx['container']} выберите, кто предоставил контейнер: заказчик или экспедитор")
                if provider == "1" and not tare:
                    raise ValueError(f"для контейнера {cargo_ctx['container']} укажите массу тары: она обязательна, если контейнер предоставил заказчик")
                container_attrs["IsContainerProvided"]=provider
                if tare:
                    if not re.fullmatch(r"\d+(?:\.\d+)?",tare):
                        raise ValueError(f"некорректная масса тары контейнера {cargo_ctx['container']}")
                    container_attrs["ContainerTareWeight"]=tare
                container=ET.SubElement(containers,"TransportContainer",container_attrs)
                if seals:
                    seal_numbers=ET.SubElement(container,"SealNumbers")
                    for seal in seals:
                        ET.SubElement(seal_numbers,"SealNumber").text=str(seal)
                ET.SubElement(container,"IntContainerId").text=cargo_ctx["container"]
            address=ET.Element("Address")
            if russian_address(address,cargo_ctx["loading"]) or russian_address(address,shipper.get("address")):
                wrapper=ET.SubElement(cargo,"CargoLocationAddress",{"CargoPickupLocation":"1"}); delivery=ET.SubElement(wrapper,"CargoDeliveryAddress"); delivery.append(address)
            services=[str(service).strip() for service in cargo_ctx.get("services",[]) if str(service).strip()]
            if services:
                service_infos=ET.SubElement(cargo,"LogisticsServiceInfos")
                for service in services:
                    ET.SubElement(service_infos,"LogisticsServiceInfo",{"ServiceName":service})
            address=ET.Element("Address")
            if russian_address(address,cargo_ctx["delivery"]) or russian_address(address,cargo_ctx["consignee"].get("address")):
                wrapper=ET.SubElement(cargo,"DestinationAddress",{"CargoDeliveryPoint":"1"}); delivery=ET.SubElement(wrapper,"CargoDeliveryAddress"); delivery.append(address)
        org(ET.SubElement(order,"ClientInfo"),client,client_edo,carrier_forwarder)
        org(ET.SubElement(order,"ForwarderInfo"),forwarder,forwarder_edo,not carrier_forwarder)
        contract_date = str(contract.get("date") or "").split("T")[0].split(" ")[0]
        if len(contract_date) == 10 and contract_date[4] == "-":
            contract_date = f"{contract_date[8:10]}.{contract_date[5:7]}.{contract_date[:4]}"
        contract_node=ET.SubElement(order,"ForwardingContractRequisites",{"DocumentName":contract.get("title") or "Договор транспортной экспедиции","DocumentNumber":contract.get("number") or "","DocumentDate":contract_date})
        ET.SubElement(contract_node,"IdentificationDetails",{"Inn":forwarder["inn"]})
        signers=ET.SubElement(root,"Signers"); signer=ET.SubElement(signers,"Signer",{"SignerPowersConfirmationMethod":"1"})
        ET.SubElement(signer,"Fio",{"LastName":parts[0],"FirstName":parts[1],**({"MiddleName":" ".join(parts[2:])} if len(parts)>2 else {})})
        def xml_safe(value):
            return "".join(char for char in str(value) if char in "\t\n\r" or 0x20 <= ord(char) <= 0xD7FF or 0xE000 <= ord(char) <= 0xFFFD)
        for element in root.iter():
            element.attrib.update({key:xml_safe(value) for key,value in element.attrib.items()})
            if element.text:
                element.text=xml_safe(element.text)
            if element.tail:
                element.tail=xml_safe(element.tail)
        return ET.tostring(root,encoding="utf-8",xml_declaration=True).decode("utf-8")

