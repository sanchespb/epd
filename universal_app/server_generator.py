from pathlib import Path
import uuid
import xml.etree.ElementTree as ET

from xml_generator import Generator as BaseGenerator, TAGLEX, address_attributes


class Generator(BaseGenerator):
    """Server-only generator without Tkinter/desktop dependencies."""

    def __init__(self, resources: Path, catalogs):
        if not (resources / "etrn_cargo_sample.xml").exists():
            resources = resources / "resources"
        super().__init__(resources, catalogs)

    @staticmethod
    def _validate(ctx, empty=False, ezz=False):
        missing = []
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
        if empty and not ctx["stock"]:
            missing.append("контейнерный сток")
        if missing:
            raise ValueError("не заполнено: " + ", ".join(missing))

    @staticmethod
    def warnings(ctx, empty=False, ezz=False):
        warnings = []
        if ezz and (not ctx.get("loading_owner", {}).get("inn") or not ctx.get("loading_owner", {}).get("name")):
            warnings.append("В справочнике не заполнены название или ИНН владельца точки погрузки. Заполните сведения о владельце вручную в заявке перед подписанием.")
        if not ezz:
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
                warnings.append("В справочнике точек маршрута не найден владелец объекта пункта погрузки.")
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

    @staticmethod
    def forwarding_order_userdata(contexts, signer_name):
        if isinstance(contexts, dict):
            contexts = [contexts]
        ctx = contexts[0]
        def russian_address(parent, text):
            attrs = address_attributes(text or "")
            region = attrs.get("КодРегион")
            if not region:
                return False
            mapped = {"Индекс":"ZipCode","КодРегион":"Region","Город":"City","НаселПункт":"Settlement","Улица":"Street","Дом":"Building","Корпус":"Block"}
            values = {mapped[key]:value for key,value in attrs.items() if key in mapped and value}
            ET.SubElement(parent, "RussianAddress", values)
            return True

        def org(parent, data, edo=""):
            details = ET.SubElement(parent, "OrganizationDetails", {
                "OrgType":"2", "OrgName":data.get("name") or "Не указано", "Inn":data.get("inn") or "",
                **({"Kpp":data.get("kpp")} if data.get("kpp") else {}),
                **({"FnsParticipantId":edo} if edo else {}),
            })
            address = ET.Element("Address")
            if russian_address(address, data.get("address") or ""):
                details.append(address)

        parts = signer_name.split()
        if len(parts) < 2:
            raise ValueError("укажите фамилию и имя подписанта клиента")
        contract = ctx.get("client_contract")
        if not contract:
            raise ValueError("для клиента не найден договор транспортной экспедиции")
        if not ctx["client"].get("inn") or not ctx.get("client_edo"):
            raise ValueError("для клиента не заполнены ИНН или ID ЭДО")
        root = ET.Element("LogisticsForwardingOrderClientTitle", {
            "ForwardingOrderId":str(uuid.uuid4()), "Number":ctx["order_number"], "Date":ctx["order_date"], "HasCargoDocs":"0",
        })
        order = ET.SubElement(root, "ClientForwarderOrder")
        cargo_infos = ET.SubElement(order, "CargoInfos")
        for cargo_ctx in contexts:
            cargo = ET.SubElement(cargo_infos, "CargoInfo", {
                "ReadyFromDate":cargo_ctx["planned_departure_datetime"].strftime("%d.%m.%Y"),
                "ReadyToDate":cargo_ctx["planned_departure_datetime"].strftime("%d.%m.%Y"),
                "TransportationIndicator":"1", "CargoBatchId":str(uuid.uuid4()), "ShipmentCargoSpaceQuantity":"1", "NotifyReq":"0",
            })
            org(ET.SubElement(cargo,"Consignee"),cargo_ctx["consignee"],cargo_ctx.get("consignee_edo",""))
            shipper = cargo_ctx.get("loading_owner") if (cargo_ctx.get("loading_owner") or {}).get("inn") else cargo_ctx["client"]
            org(ET.SubElement(cargo,"Shipper"),shipper)
            ET.SubElement(ET.SubElement(cargo,"TransportInfos"),"TransportInfo",{"TransportType":"1","BodyType":"Контейнеровоз"})
            weight = cargo_ctx.get("weight") or "0"
            ET.SubElement(cargo,"BatchWeight",{"NetWeight":weight,"GrossWeight":weight})
            descriptions=ET.SubElement(cargo,"ItemDescriptions")
            item=ET.SubElement(descriptions,"ItemDescription",{"Name":f"Контейнер {cargo_ctx['container']}","CargoSpaceQuantity":"1","HasDangerous":"0","HasRestrictedItems":"0","CanSpecifyVolume":"0","IsForStateSystemRegistration":"0","HasPackaging":"0","HasCommodityCode":"0"})
            ET.SubElement(ET.SubElement(item,"Marks"),"Mark").text=cargo_ctx["container"]
            ET.SubElement(ET.SubElement(item,"CargoNumbers"),"CargoNumber").text=cargo_ctx["container"]
            containers=ET.SubElement(cargo,"TransportContainers")
            ET.SubElement(containers,"TransportContainer",{"ContainerNumber":cargo_ctx["container"],"ContainerPurpose":"2"})
            address=ET.Element("Address")
            if russian_address(address,cargo_ctx["loading"]) or russian_address(address,shipper.get("address")):
                wrapper=ET.SubElement(cargo,"CargoLocationAddress",{"CargoPickupLocation":"1"}); delivery=ET.SubElement(wrapper,"CargoDeliveryAddress"); delivery.append(address)
        org(ET.SubElement(order,"ClientInfo"),ctx["client"],ctx["client_edo"])
        org(ET.SubElement(order,"ForwarderInfo"),TAGLEX,TAGLEX["edo"])
        contract_date = str(contract.get("date") or "").split("T")[0].split(" ")[0]
        if len(contract_date) == 10 and contract_date[4] == "-":
            contract_date = f"{contract_date[8:10]}.{contract_date[5:7]}.{contract_date[:4]}"
        contract_node=ET.SubElement(order,"ForwardingContractRequisites",{"DocumentName":contract.get("title") or "Договор транспортной экспедиции","DocumentNumber":contract.get("number") or "","DocumentDate":contract_date})
        ET.SubElement(contract_node,"IdentificationDetails",{"Inn":TAGLEX["inn"]})
        signers=ET.SubElement(root,"Signers"); signer=ET.SubElement(signers,"Signer",{"SignerPowersConfirmationMethod":"1"})
        ET.SubElement(signer,"Fio",{"LastName":parts[0],"FirstName":parts[1],**({"MiddleName":" ".join(parts[2:])} if len(parts)>2 else {})})
        return ET.tostring(root,encoding="utf-8",xml_declaration=True).decode("utf-8")

