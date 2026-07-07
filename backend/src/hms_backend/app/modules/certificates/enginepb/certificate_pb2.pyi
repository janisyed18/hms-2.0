from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class EndConfiguration(_message.Message):
    __slots__ = ("end", "nominal_bore", "material", "coupling", "coupling_add_on", "attach_method")
    END_FIELD_NUMBER: _ClassVar[int]
    NOMINAL_BORE_FIELD_NUMBER: _ClassVar[int]
    MATERIAL_FIELD_NUMBER: _ClassVar[int]
    COUPLING_FIELD_NUMBER: _ClassVar[int]
    COUPLING_ADD_ON_FIELD_NUMBER: _ClassVar[int]
    ATTACH_METHOD_FIELD_NUMBER: _ClassVar[int]
    end: str
    nominal_bore: str
    material: str
    coupling: str
    coupling_add_on: str
    attach_method: str
    def __init__(self, end: _Optional[str] = ..., nominal_bore: _Optional[str] = ..., material: _Optional[str] = ..., coupling: _Optional[str] = ..., coupling_add_on: _Optional[str] = ..., attach_method: _Optional[str] = ...) -> None: ...

class PressureTest(_message.Message):
    __slots__ = ("working_pressure_kpa", "test_pressure_kpa", "applied_pressure_kpa", "hold_time_seconds", "passed", "medium")
    WORKING_PRESSURE_KPA_FIELD_NUMBER: _ClassVar[int]
    TEST_PRESSURE_KPA_FIELD_NUMBER: _ClassVar[int]
    APPLIED_PRESSURE_KPA_FIELD_NUMBER: _ClassVar[int]
    HOLD_TIME_SECONDS_FIELD_NUMBER: _ClassVar[int]
    PASSED_FIELD_NUMBER: _ClassVar[int]
    MEDIUM_FIELD_NUMBER: _ClassVar[int]
    working_pressure_kpa: int
    test_pressure_kpa: int
    applied_pressure_kpa: int
    hold_time_seconds: int
    passed: bool
    medium: str
    def __init__(self, working_pressure_kpa: _Optional[int] = ..., test_pressure_kpa: _Optional[int] = ..., applied_pressure_kpa: _Optional[int] = ..., hold_time_seconds: _Optional[int] = ..., passed: _Optional[bool] = ..., medium: _Optional[str] = ...) -> None: ...

class Party(_message.Message):
    __slots__ = ("id", "name")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ...) -> None: ...

class Issuer(_message.Message):
    __slots__ = ("name", "address", "contact", "identifier")
    NAME_FIELD_NUMBER: _ClassVar[int]
    ADDRESS_FIELD_NUMBER: _ClassVar[int]
    CONTACT_FIELD_NUMBER: _ClassVar[int]
    IDENTIFIER_FIELD_NUMBER: _ClassVar[int]
    name: str
    address: str
    contact: str
    identifier: str
    def __init__(self, name: _Optional[str] = ..., address: _Optional[str] = ..., contact: _Optional[str] = ..., identifier: _Optional[str] = ...) -> None: ...

class CertificateData(_message.Message):
    __slots__ = ("certificate_number", "certificate_version", "status", "issued_at", "valid_until", "customer_code", "customer_name", "site_name", "site_location", "asset_number", "asset_tag", "customer_serial_no", "manufacture_date", "length_m", "lifecycle_status", "product_code", "product_name", "product_category", "standard_code", "standard_name", "ends", "pressure_test", "inspection_id", "inspection_type", "inspection_result", "inspector", "reviewer", "submitted_at", "approved_at", "issued_by", "issuer", "public_token", "verify_url")
    CERTIFICATE_NUMBER_FIELD_NUMBER: _ClassVar[int]
    CERTIFICATE_VERSION_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    ISSUED_AT_FIELD_NUMBER: _ClassVar[int]
    VALID_UNTIL_FIELD_NUMBER: _ClassVar[int]
    CUSTOMER_CODE_FIELD_NUMBER: _ClassVar[int]
    CUSTOMER_NAME_FIELD_NUMBER: _ClassVar[int]
    SITE_NAME_FIELD_NUMBER: _ClassVar[int]
    SITE_LOCATION_FIELD_NUMBER: _ClassVar[int]
    ASSET_NUMBER_FIELD_NUMBER: _ClassVar[int]
    ASSET_TAG_FIELD_NUMBER: _ClassVar[int]
    CUSTOMER_SERIAL_NO_FIELD_NUMBER: _ClassVar[int]
    MANUFACTURE_DATE_FIELD_NUMBER: _ClassVar[int]
    LENGTH_M_FIELD_NUMBER: _ClassVar[int]
    LIFECYCLE_STATUS_FIELD_NUMBER: _ClassVar[int]
    PRODUCT_CODE_FIELD_NUMBER: _ClassVar[int]
    PRODUCT_NAME_FIELD_NUMBER: _ClassVar[int]
    PRODUCT_CATEGORY_FIELD_NUMBER: _ClassVar[int]
    STANDARD_CODE_FIELD_NUMBER: _ClassVar[int]
    STANDARD_NAME_FIELD_NUMBER: _ClassVar[int]
    ENDS_FIELD_NUMBER: _ClassVar[int]
    PRESSURE_TEST_FIELD_NUMBER: _ClassVar[int]
    INSPECTION_ID_FIELD_NUMBER: _ClassVar[int]
    INSPECTION_TYPE_FIELD_NUMBER: _ClassVar[int]
    INSPECTION_RESULT_FIELD_NUMBER: _ClassVar[int]
    INSPECTOR_FIELD_NUMBER: _ClassVar[int]
    REVIEWER_FIELD_NUMBER: _ClassVar[int]
    SUBMITTED_AT_FIELD_NUMBER: _ClassVar[int]
    APPROVED_AT_FIELD_NUMBER: _ClassVar[int]
    ISSUED_BY_FIELD_NUMBER: _ClassVar[int]
    ISSUER_FIELD_NUMBER: _ClassVar[int]
    PUBLIC_TOKEN_FIELD_NUMBER: _ClassVar[int]
    VERIFY_URL_FIELD_NUMBER: _ClassVar[int]
    certificate_number: str
    certificate_version: int
    status: str
    issued_at: str
    valid_until: str
    customer_code: str
    customer_name: str
    site_name: str
    site_location: str
    asset_number: str
    asset_tag: str
    customer_serial_no: str
    manufacture_date: str
    length_m: str
    lifecycle_status: str
    product_code: str
    product_name: str
    product_category: str
    standard_code: str
    standard_name: str
    ends: _containers.RepeatedCompositeFieldContainer[EndConfiguration]
    pressure_test: PressureTest
    inspection_id: str
    inspection_type: str
    inspection_result: str
    inspector: Party
    reviewer: Party
    submitted_at: str
    approved_at: str
    issued_by: Party
    issuer: Issuer
    public_token: str
    verify_url: str
    def __init__(self, certificate_number: _Optional[str] = ..., certificate_version: _Optional[int] = ..., status: _Optional[str] = ..., issued_at: _Optional[str] = ..., valid_until: _Optional[str] = ..., customer_code: _Optional[str] = ..., customer_name: _Optional[str] = ..., site_name: _Optional[str] = ..., site_location: _Optional[str] = ..., asset_number: _Optional[str] = ..., asset_tag: _Optional[str] = ..., customer_serial_no: _Optional[str] = ..., manufacture_date: _Optional[str] = ..., length_m: _Optional[str] = ..., lifecycle_status: _Optional[str] = ..., product_code: _Optional[str] = ..., product_name: _Optional[str] = ..., product_category: _Optional[str] = ..., standard_code: _Optional[str] = ..., standard_name: _Optional[str] = ..., ends: _Optional[_Iterable[_Union[EndConfiguration, _Mapping]]] = ..., pressure_test: _Optional[_Union[PressureTest, _Mapping]] = ..., inspection_id: _Optional[str] = ..., inspection_type: _Optional[str] = ..., inspection_result: _Optional[str] = ..., inspector: _Optional[_Union[Party, _Mapping]] = ..., reviewer: _Optional[_Union[Party, _Mapping]] = ..., submitted_at: _Optional[str] = ..., approved_at: _Optional[str] = ..., issued_by: _Optional[_Union[Party, _Mapping]] = ..., issuer: _Optional[_Union[Issuer, _Mapping]] = ..., public_token: _Optional[str] = ..., verify_url: _Optional[str] = ...) -> None: ...

class RenderRequest(_message.Message):
    __slots__ = ("certificate",)
    CERTIFICATE_FIELD_NUMBER: _ClassVar[int]
    certificate: CertificateData
    def __init__(self, certificate: _Optional[_Union[CertificateData, _Mapping]] = ...) -> None: ...

class RenderResponse(_message.Message):
    __slots__ = ("pdf", "verification_hash", "page_count", "signer_common_name", "signed_at", "signed")
    PDF_FIELD_NUMBER: _ClassVar[int]
    VERIFICATION_HASH_FIELD_NUMBER: _ClassVar[int]
    PAGE_COUNT_FIELD_NUMBER: _ClassVar[int]
    SIGNER_COMMON_NAME_FIELD_NUMBER: _ClassVar[int]
    SIGNED_AT_FIELD_NUMBER: _ClassVar[int]
    SIGNED_FIELD_NUMBER: _ClassVar[int]
    pdf: bytes
    verification_hash: str
    page_count: int
    signer_common_name: str
    signed_at: str
    signed: bool
    def __init__(self, pdf: _Optional[bytes] = ..., verification_hash: _Optional[str] = ..., page_count: _Optional[int] = ..., signer_common_name: _Optional[str] = ..., signed_at: _Optional[str] = ..., signed: _Optional[bool] = ...) -> None: ...
