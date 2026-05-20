#!/usr/bin/env python3
import base64
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from urllib.parse import quote, urlparse


HOST = os.environ.get("DIRECT_CONNECTOR_HOST", "0.0.0.0")
PORT = int(os.environ.get("DIRECT_CONNECTOR_PORT", "8000"))
PUBLIC_BASE_URL = os.environ.get("DIRECT_PUBLIC_BASE_URL", "").rstrip("/")
DOCUMENT_BASE_URL = os.environ.get("DIRECT_DOCUMENT_BASE_URL", "").rstrip("/")
DOCUMENT_SERVER_PUBLIC_URL = os.environ.get("DOCUMENT_SERVER_PUBLIC_URL", "/ds/").rstrip("/") + "/"
DOCUMENT_SERVER_INTERNAL_URL = os.environ.get("DOCUMENT_SERVER_INTERNAL_URL", "http://onlyoffice/").rstrip("/") + "/"
SESSION_TTL_SECONDS = int(os.environ.get("DIRECT_SESSION_TTL_SECONDS", str(8 * 60 * 60)))
MAX_UPLOAD_BYTES = int(os.environ.get("DIRECT_MAX_UPLOAD_BYTES", str(64 * 1024 * 1024)))
EDITOR_HTML = Path(__file__).with_name("editor.html").read_text(encoding="utf-8")

SESSIONS = {}


def now():
    return int(time.time())


def json_bytes(data):
    return json.dumps(data, separators=(",", ":")).encode("utf-8")


def clean_filename(filename, file_type):
    value = str(filename or "").strip().replace("\\", "/").split("/")[-1]
    if not value:
        value = "Document." + file_type
    value = re.sub(r"[^A-Za-z0-9._ -]+", "_", value).strip(" .")
    if "." not in value:
        value += "." + file_type
    return value or ("Document." + file_type)


def file_type_for(filename, requested):
    requested = str(requested or "").lower().strip().lstrip(".")
    if requested in {"docx", "xlsx", "pptx"}:
        return requested
    ext = str(filename or "").rsplit(".", 1)
    if len(ext) == 2 and ext[1].lower() in {"docx", "xlsx", "pptx"}:
        return ext[1].lower()
    return "docx"


def document_type_for(file_type):
    if file_type == "xlsx":
        return "cell"
    if file_type == "pptx":
        return "slide"
    return "word"


def content_type_for(file_type):
    if file_type == "xlsx":
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    if file_type == "pptx":
        return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def zip_bytes(entries):
    out = BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return out.getvalue()


def blank_docx():
    return zip_bytes({
        "[Content_Types].xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>""",
        "_rels/.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>""",
        "word/document.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>""",
    })


def blank_xlsx():
    return zip_bytes({
        "[Content_Types].xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>""",
        "_rels/.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>""",
        "xl/workbook.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>""",
        "xl/_rels/workbook.xml.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>""",
        "xl/worksheets/sheet1.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>""",
    })


def blank_pptx():
    return zip_bytes({
        "[Content_Types].xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>
<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>
<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
</Types>""",
        "_rels/.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>""",
        "docProps/app.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Kin ONLYOFFICE</Application><PresentationFormat>On-screen Show (4:3)</PresentationFormat><Slides>1</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides><MMClips>0</MMClips><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Theme</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Office Theme</vt:lpstr></vt:vector></TitlesOfParts><Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>""",
        "docProps/core.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title></dc:title><dc:creator>Kin ONLYOFFICE</dc:creator><cp:lastModifiedBy>Kin ONLYOFFICE</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>""",
        "ppt/presentation.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>""",
        "ppt/_rels/presentation.xml.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>
</Relationships>""",
        "ppt/presProps.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentationPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>""",
        "ppt/viewProps.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:viewPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:slideViewPr><p:cSldViewPr><p:cViewPr varScale="1"><p:scale><p:sx n="100" d="100"/><p:sy n="100" d="100"/></p:scale><p:origin x="0" y="0"/></p:cViewPr><p:guideLst/></p:cSldViewPr></p:slideViewPr></p:viewPr>""",
        "ppt/tableStyles.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>""",
        "ppt/slideMasters/slideMaster1.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>""",
        "ppt/slideMasters/_rels/slideMaster1.xml.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>""",
        "ppt/slideLayouts/slideLayout1.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>""",
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>""",
        "ppt/slides/slide1.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>""",
        "ppt/slides/_rels/slide1.xml.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>""",
        "ppt/theme/theme1.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/><a:satMod val="300000"/></a:schemeClr></a:gs><a:gs pos="35000"><a:schemeClr val="phClr"><a:tint val="37000"/><a:satMod val="300000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="15000"/><a:satMod val="350000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="1"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:shade val="51000"/><a:satMod val="130000"/></a:schemeClr></a:gs><a:gs pos="80000"><a:schemeClr val="phClr"><a:shade val="93000"/><a:satMod val="130000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="94000"/><a:satMod val="135000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="0"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"><a:shade val="95000"/><a:satMod val="105000"/></a:schemeClr></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="40000"/><a:satMod val="350000"/></a:schemeClr></a:gs><a:gs pos="40000"><a:schemeClr val="phClr"><a:tint val="45000"/><a:shade val="99000"/><a:satMod val="350000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="20000"/><a:satMod val="255000"/></a:schemeClr></a:gs></a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="-80000" r="50000" b="180000"/></a:path></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="80000"/><a:satMod val="300000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="30000"/><a:satMod val="200000"/></a:schemeClr></a:gs></a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>""",
    })


def blank_bytes(file_type):
    if file_type == "xlsx":
        return blank_xlsx()
    if file_type == "pptx":
        return blank_pptx()
    return blank_docx()


def public_base(handler):
    if PUBLIC_BASE_URL:
        return PUBLIC_BASE_URL
    proto = handler.headers.get("X-Forwarded-Proto") or "https"
    host = handler.headers.get("X-Forwarded-Host") or handler.headers.get("Host") or "localhost"
    prefix = (handler.headers.get("X-Forwarded-Prefix") or "").strip().rstrip("/")
    if prefix and not prefix.startswith("/"):
        prefix = "/" + prefix
    return f"{proto}://{host}{prefix}/direct"


def session_public_urls(handler, session):
    base = public_base(handler)
    document_base = DOCUMENT_BASE_URL or base
    sid = session["id"]
    filename = quote(session["filename"])
    version = session["version"]
    return {
        "download": f"{document_base}/download/{sid}/{filename}?v={version}",
        "callback": f"{document_base}/callback/{sid}",
        "editor": f"{base}/editor?session={sid}",
    }


def make_config(handler, session):
    urls = session_public_urls(handler, session)
    return {
        "document": {
            "fileType": session["file_type"],
            "key": session["document_key"],
            "title": session["filename"],
            "url": urls["download"],
            "permissions": {
                "download": True,
                "edit": True,
                "print": True,
                "review": True,
            },
        },
        "documentType": document_type_for(session["file_type"]),
        "editorConfig": {
            "callbackUrl": urls["callback"],
            "lang": "en",
            "mode": "edit",
            "user": {
                "id": session.get("user_id") or "kin-user",
                "name": session.get("user_name") or "Kin User",
            },
            "customization": {
                "autosave": True,
                "forcesave": True,
            },
        },
        "type": "desktop",
        "width": "100%",
        "height": "100%",
    }


def cleanup_sessions():
    cutoff = now() - SESSION_TTL_SECONDS
    stale = [sid for sid, data in SESSIONS.items() if data.get("last_seen", 0) < cutoff]
    for sid in stale:
        SESSIONS.pop(sid, None)


def response_for_session(handler, session):
    urls = session_public_urls(handler, session)
    return {
        "response": "success",
        "sessionId": session["id"],
        "documentKey": session["document_key"],
        "fileType": session["file_type"],
        "filename": session["filename"],
        "version": session["version"],
        "editorUrl": urls["editor"],
        "state": session_state(session),
        "info": info_payload(session),
    }


def session_state(session):
    return {
        "sessionId": session["id"],
        "documentKey": session["document_key"],
        "filePath": session.get("file_path") or "",
        "fileType": session["file_type"],
        "filename": session["filename"],
        "version": session["version"],
        "lastSavedAt": session.get("last_saved_at"),
        "lastCallbackStatus": session.get("last_callback_status"),
        "lastCallbackAt": session.get("last_callback_at"),
        "savePending": bool(session.get("save_pending")),
        "users": session.get("users", []),
    }


def info_payload(session):
    return {
        "mode": "direct",
        "sessionId": session["id"],
        "documentKey": session["document_key"],
        "filePath": session.get("file_path") or "",
        "fileType": session["file_type"],
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "version": session["version"],
    }


def create_session(data):
    filename = data.get("filename") or data.get("name") or ""
    file_type = file_type_for(filename, data.get("file_type") or data.get("fileType"))
    filename = clean_filename(filename, file_type)

    content = None
    encoded = data.get("data_base64") or data.get("dataBase64")
    if encoded:
        content = base64.b64decode(str(encoded), validate=False)
    else:
        content = blank_bytes(file_type)
    if len(content) > MAX_UPLOAD_BYTES:
        raise ValueError("Document is too large for direct editing.")

    session_id = uuid.uuid4().hex
    document_key = "kin-" + uuid.uuid4().hex
    user_id = str(data.get("user_id") or data.get("userId") or "kin-user")
    user_name = str(data.get("user_name") or data.get("userName") or "Kin User")
    session = {
        "id": session_id,
        "document_key": document_key,
        "file_path": str(data.get("path") or data.get("filePath") or ""),
        "file_type": file_type,
        "filename": filename,
        "content": content,
        "version": 1,
        "created_at": now(),
        "last_seen": now(),
        "last_saved_at": None,
        "last_callback_status": None,
        "last_callback_at": None,
        "save_pending": False,
        "user_id": user_id,
        "user_name": user_name,
        "users": [{"id": user_id, "name": user_name}],
    }
    SESSIONS[session_id] = session
    return session


def join_session(data):
    session_id = str(data.get("sessionId") or data.get("session_id") or "").strip()
    if not session_id or session_id not in SESSIONS:
        return None
    session = SESSIONS[session_id]
    expected_path = str(data.get("path") or data.get("filePath") or "")
    if expected_path and session.get("file_path") and expected_path != session.get("file_path"):
        return None
    session["last_seen"] = now()
    user_id = str(data.get("user_id") or data.get("userId") or "kin-user")
    user_name = str(data.get("user_name") or data.get("userName") or "Kin User")
    if not any(user.get("id") == user_id for user in session["users"]):
        session["users"].append({"id": user_id, "name": user_name})
    return session


def fetch_url(url):
    context = ssl._create_unverified_context()
    request = urllib.request.Request(url, headers={"User-Agent": "kin-onlyoffice-direct/1.0"})
    with urllib.request.urlopen(request, timeout=60, context=context) as response:
        return response.read()


def post_command(payload):
    endpoint = DOCUMENT_SERVER_INTERNAL_URL + "coauthoring/CommandService.ashx"
    body = json_bytes(payload)
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        text = response.read().decode("utf-8", errors="replace")
        return response.status, text


class Handler(BaseHTTPRequestHandler):
    server_version = "KinOnlyOfficeDirect/1.0"

    def log_message(self, fmt, *args):
        print("%s - - [%s] %s" % (self.address_string(), self.log_date_time_string(), fmt % args), flush=True)

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        self.send_header("Access-Control-Max-Age", "86400")

    def send_json(self, status, data):
        body = json_bytes(data)
        self.send_response(status)
        self.send_cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, status, body, content_type, extra_headers=None):
        self.send_response(status)
        self.send_cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or "0")
        if length > MAX_UPLOAD_BYTES * 2:
            raise ValueError("Request is too large.")
        raw = self.rfile.read(length) if length else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def route(self):
        path = urlparse(self.path).path
        if path.startswith("/direct/"):
            path = path[len("/direct"):]
        return path or "/"

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        cleanup_sessions()
        path = self.route()
        try:
            if path == "/health":
                self.send_json(200, {"response": "success"})
                return
            if path == "/editor":
                self.send_bytes(200, EDITOR_HTML.encode("utf-8"), "text/html; charset=utf-8")
                return
            match = re.match(r"^/api/session/([^/]+)/config$", path)
            if match:
                session = SESSIONS.get(match.group(1))
                if not session:
                    self.send_json(404, {"response": "fail", "message": "Session not found."})
                    return
                session["last_seen"] = now()
                self.send_json(200, {
                    "response": "success",
                    "api_url": DOCUMENT_SERVER_PUBLIC_URL + "web-apps/apps/api/documents/api.js",
                    "config": make_config(self, session),
                })
                return
            match = re.match(r"^/api/session/([^/]+)/state$", path)
            if match:
                session = SESSIONS.get(match.group(1))
                if not session:
                    self.send_json(404, {"response": "fail", "message": "Session not found."})
                    return
                session["last_seen"] = now()
                self.send_json(200, {"response": "success", "state": session_state(session), "info": info_payload(session)})
                return
            match = re.match(r"^/api/session/([^/]+)/content$", path)
            if match:
                session = SESSIONS.get(match.group(1))
                if not session:
                    self.send_json(404, {"response": "fail", "message": "Session not found."})
                    return
                session["last_seen"] = now()
                self.send_json(200, {
                    "response": "success",
                    "data_base64": base64.b64encode(session["content"]).decode("ascii"),
                    "state": session_state(session),
                    "info": info_payload(session),
                })
                return
            match = re.match(r"^/download/([^/]+)/([^/]+)$", path)
            if match:
                session = SESSIONS.get(match.group(1))
                if not session:
                    self.send_json(404, {"response": "fail", "message": "Session not found."})
                    return
                session["last_seen"] = now()
                self.send_bytes(200, session["content"], content_type_for(session["file_type"]), {
                    "Cache-Control": "no-store",
                    "Content-Disposition": 'inline; filename="%s"' % session["filename"].replace('"', "_"),
                })
                return
            self.send_json(404, {"response": "fail", "message": "Not found."})
        except Exception as error:
            self.send_json(500, {"response": "fail", "message": str(error)})

    def do_POST(self):
        cleanup_sessions()
        path = self.route()
        try:
            if path == "/api/session":
                data = self.read_json()
                encoded = data.get("data_base64") or data.get("dataBase64")
                reload_from_disk = bool(
                    encoded
                    or data.get("reloadFromDisk")
                    or data.get("reload_from_disk")
                )
                session = None
                if not reload_from_disk:
                    info = data.get("info") or {}
                    direct_info = info.get("kinOnlyOffice") if isinstance(info, dict) else None
                    if isinstance(direct_info, dict) and direct_info.get("sessionId"):
                        data["sessionId"] = direct_info.get("sessionId")
                        session = join_session(data)
                if not session:
                    session = create_session(data)
                self.send_json(200, response_for_session(self, session))
                return
            if path == "/api/session/join":
                session = join_session(self.read_json())
                if not session:
                    self.send_json(404, {"response": "fail", "message": "Session not found or stale."})
                    return
                self.send_json(200, response_for_session(self, session))
                return
            match = re.match(r"^/api/session/([^/]+)/forcesave$", path)
            if match:
                session = SESSIONS.get(match.group(1))
                if not session:
                    self.send_json(404, {"response": "fail", "message": "Session not found."})
                    return
                session["save_pending"] = True
                status, text = post_command({"c": "forcesave", "key": session["document_key"]})
                parsed = None
                try:
                    parsed = json.loads(text)
                except Exception:
                    parsed = None
                self.send_json(200, {
                    "response": "success",
                    "status": status,
                    "body": text,
                    "accepted": bool(parsed and parsed.get("error") == 0),
                    "state": session_state(session),
                })
                return
            match = re.match(r"^/callback/([^/]+)$", path)
            if match:
                session = SESSIONS.get(match.group(1))
                callback = self.read_json()
                if not session:
                    self.send_json(200, {"error": 0})
                    return
                session["last_callback_status"] = callback.get("status")
                session["last_callback_at"] = now()
                status = callback.get("status")
                if status in (2, 6) and callback.get("url"):
                    content = fetch_url(str(callback.get("url")))
                    if content:
                        session["content"] = content
                        session["version"] += 1
                        session["last_saved_at"] = now()
                        session["save_pending"] = False
                elif status in (1, 4):
                    session["save_pending"] = True
                self.send_json(200, {"error": 0})
                return
            self.send_json(404, {"response": "fail", "message": "Not found."})
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"response": "fail", "message": str(error)})
        except urllib.error.URLError as error:
            self.send_json(502, {"response": "fail", "message": str(error)})
        except Exception as error:
            self.send_json(500, {"response": "fail", "message": str(error)})


if __name__ == "__main__":
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"direct connector listening on {HOST}:{PORT}", flush=True)
    httpd.serve_forever()
