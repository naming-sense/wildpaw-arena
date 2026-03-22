from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape
import zipfile

OUT = Path('/home/namingsense/.openclaw/workspace-gameDesign/docs/ai-game-dev-guidelines-team-one-page.pptx')

NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS_CP = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties'
NS_DC = 'http://purl.org/dc/elements/1.1/'
NS_DCT = 'http://purl.org/dc/terms/'
NS_DCMIT = 'http://purl.org/dc/dcmitype/'
NS_XSI = 'http://www.w3.org/2001/XMLSchema-instance'

SLIDE_W = 12192000
SLIDE_H = 6858000


def xml(text: str) -> str:
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + text.strip() + '\n'


def paragraph(text: str, size: int = 2000, bold: bool = False, align: str = 'l') -> str:
    attrs = [f'lang="ko-KR"', f'sz="{size}"']
    if bold:
        attrs.append('b="1"')
    attr_text = ' '.join(attrs)
    return (
        f'<a:p>'
        f'<a:pPr algn="{align}"/>'
        f'<a:r><a:rPr {attr_text}/><a:t>{escape(text)}</a:t></a:r>'
        f'<a:endParaRPr {attr_text}/>'
        f'</a:p>'
    )


def textbox(shape_id: int, name: str, x: int, y: int, cx: int, cy: int, paragraphs: list[str], fill: str | None = None) -> str:
    fill_xml = '<a:noFill/>' if fill is None else f'<a:solidFill><a:srgbClr val="{fill}"/></a:solidFill>'
    line_xml = '<a:ln><a:noFill/></a:ln>'
    return f'''
    <p:sp>
      <p:nvSpPr>
        <p:cNvPr id="{shape_id}" name="{escape(name)}"/>
        <p:cNvSpPr txBox="1"/>
        <p:nvPr/>
      </p:nvSpPr>
      <p:spPr>
        <a:xfrm>
          <a:off x="{x}" y="{y}"/>
          <a:ext cx="{cx}" cy="{cy}"/>
        </a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        {fill_xml}
        {line_xml}
      </p:spPr>
      <p:txBody>
        <a:bodyPr wrap="square" rtlCol="0" anchor="t"/>
        <a:lstStyle/>
        {''.join(paragraphs)}
      </p:txBody>
    </p:sp>
    '''


def slide_xml(shapes: list[str]) -> str:
    return xml(f'''
    <p:sld xmlns:a="{NS_A}" xmlns:r="{NS_R}" xmlns:p="{NS_P}">
      <p:cSld>
        <p:spTree>
          <p:nvGrpSpPr>
            <p:cNvPr id="1" name=""/>
            <p:cNvGrpSpPr/>
            <p:nvPr/>
          </p:nvGrpSpPr>
          <p:grpSpPr>
            <a:xfrm>
              <a:off x="0" y="0"/>
              <a:ext cx="0" cy="0"/>
              <a:chOff x="0" y="0"/>
              <a:chExt cx="0" cy="0"/>
            </a:xfrm>
          </p:grpSpPr>
          {''.join(shapes)}
        </p:spTree>
      </p:cSld>
      <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
    </p:sld>
    ''')


def slide_rels_xml() -> str:
    return xml(f'''
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="{NS_R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
    </Relationships>
    ''')


def make_slides() -> list[tuple[str, str]]:
    slides: list[tuple[str, str]] = []

    # Slide 1
    shapes = [
        textbox(2, 'Title', 700000, 800000, 10800000, 900000, [paragraph('AI를 활용한 서버/클라이언트 개발 가이드라인', 2600, True, 'ctr')]),
        textbox(3, 'Subtitle', 1500000, 2000000, 9000000, 1800000, [
            paragraph('팀 공유용 1페이지 요약', 1800, True, 'ctr'),
            paragraph('A는 검증용, B는 편입용', 1600, False, 'ctr'),
            paragraph('AI는 블랙박스 자동 구현 도구가 아니다', 1600, False, 'ctr'),
        ]),
    ]
    slides.append(('표지', slide_xml(shapes)))

    # Slide 2
    shapes = [
        textbox(2, 'Title', 700000, 400000, 10800000, 700000, [paragraph('먼저 깔고 가야 할 생각', 2400, True)]),
        textbox(3, 'Body', 900000, 1400000, 10400000, 4200000, [
            paragraph('• AI 활용의 핵심은 내 지식베이스를 넓히는 데 있다', 1800),
            paragraph('• AI가 만든 내용은 가능한 한 내가 이해할 수 있어야 한다', 1800),
            paragraph('• B에서는 AI보다 직접 개발이 더 빠를 때도 있다', 1800),
            paragraph('• 그래도 장기적으로는 AI와 페어하게 개발하는 편이 유리하다', 1800),
        ]),
    ]
    slides.append(('먼저 깔고 가야 할 생각', slide_xml(shapes)))

    # Slide 3
    shapes = [
        textbox(2, 'Title', 700000, 400000, 10800000, 700000, [paragraph('A와 B를 나누는 기준', 2400, True)]),
        textbox(3, 'AHeader', 900000, 1400000, 4600000, 500000, [paragraph('A를 선택하는 경우', 1800, True)], fill='EAF2FF'),
        textbox(4, 'ABody', 900000, 2000000, 4600000, 3300000, [
            paragraph('• 빠른 검증이 목적일 때', 1600),
            paragraph('• 감각, 흐름, 기술 가능성을 먼저 볼 때', 1600),
            paragraph('• 코드가 나중에 버려져도 괜찮을 때', 1600),
            paragraph('• 문서와 시나리오를 고쳐 다시 볼 생각일 때', 1600),
        ]),
        textbox(5, 'BHeader', 6100000, 1400000, 4600000, 500000, [paragraph('B를 선택하는 경우', 1800, True)], fill='EEF7EA'),
        textbox(6, 'BBody', 6100000, 2000000, 4600000, 3300000, [
            paragraph('• 메인 프로젝트에 넣어야 할 때', 1600),
            paragraph('• 다른 개발자와 협업해야 할 때', 1600),
            paragraph('• 코드 리뷰와 유지보수가 필요할 때', 1600),
            paragraph('• 실제 코드와 구조를 분석해 고쳐야 할 때', 1600),
        ]),
    ]
    slides.append(('A와 B를 나누는 기준', slide_xml(shapes)))

    # Slide 4
    shapes = [
        textbox(2, 'Title', 700000, 400000, 10800000, 700000, [paragraph('기본 작업 흐름', 2400, True)]),
        textbox(3, 'Flow', 900000, 1400000, 10400000, 4200000, [
            paragraph('1. 요구사항 / 개발 계획을 md로 정리', 1800, True),
            paragraph('2. md 기준으로 작은 단위 구현', 1800, True),
            paragraph('3. AI 리뷰, 인간 리뷰, 테스트 진행', 1800, True),
            paragraph('4. 수정사항 정리 후 다시 1번으로', 1800, True),
        ]),
    ]
    slides.append(('기본 작업 흐름', slide_xml(shapes)))

    # Slide 5
    shapes = [
        textbox(2, 'Title', 700000, 400000, 10800000, 700000, [paragraph('수정하는 기준의 차이', 2400, True)]),
        textbox(3, 'AHeader', 900000, 1400000, 4600000, 500000, [paragraph('A: 문서를 수정하면서 검증', 1800, True)], fill='EAF2FF'),
        textbox(4, 'ABody', 900000, 2000000, 4600000, 3000000, [
            paragraph('• 요구사항과 계획을 다시 본다', 1600),
            paragraph('• 테스트 시나리오를 다시 정리한다', 1600),
            paragraph('• 테스트용 데이터와 입력값을 조정한다', 1600),
            paragraph('• 문서를 고치고 다시 구현한다', 1600),
        ]),
        textbox(5, 'BHeader', 6100000, 1400000, 4600000, 500000, [paragraph('B: 코드와 구조를 수정하며 편입', 1800, True)], fill='EEF7EA'),
        textbox(6, 'BBody', 6100000, 2000000, 4600000, 3000000, [
            paragraph('• 문제 코드 경로와 상태 전이를 찾는다', 1600),
            paragraph('• 구조와 책임 분리를 다시 본다', 1600),
            paragraph('• 코드와 문서를 함께 수정한다', 1600),
            paragraph('• 리뷰와 테스트 후 다시 검증한다', 1600),
        ]),
    ]
    slides.append(('수정하는 기준의 차이', slide_xml(shapes)))

    # Slide 6
    shapes = [
        textbox(2, 'Title', 700000, 400000, 10800000, 700000, [paragraph('팀 적용 원칙', 2400, True)]),
        textbox(3, 'Body', 900000, 1400000, 10400000, 4200000, [
            paragraph('• B는 시작 전에 코드베이스 분석과 규칙 파악이 먼저다', 1800),
            paragraph('• AI는 분석 / 문서 작성 / 구현 / 리뷰 / 테스트로 나눠서 쓴다', 1800),
            paragraph('• 큰 범위를 한 번에 맡기지 않는다', 1800),
            paragraph('• 팀에서 기억할 한 문장: AI는 지식베이스를 넓히는 페어 개발 도구다', 1800, True),
        ]),
    ]
    slides.append(('팀 적용 원칙', slide_xml(shapes)))

    return slides


def content_types(slide_count: int) -> str:
    overrides = '\n'.join(
        f'  <Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        for i in range(1, slide_count + 1)
    )
    return xml(f'''
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
      <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
      <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
      <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
      <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
      <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
      {overrides}
    </Types>
    ''')


def root_rels() -> str:
    return xml(f'''
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="{NS_R}/officeDocument" Target="ppt/presentation.xml"/>
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
      <Relationship Id="rId3" Type="{NS_R}/extended-properties" Target="docProps/app.xml"/>
    </Relationships>
    ''')


def core_xml() -> str:
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    return xml(f'''
    <cp:coreProperties xmlns:cp="{NS_CP}" xmlns:dc="{NS_DC}" xmlns:dcterms="{NS_DCT}" xmlns:dcmitype="{NS_DCMIT}" xmlns:xsi="{NS_XSI}">
      <dc:title>AI를 활용한 서버/클라이언트 개발 가이드라인 - 팀 공유용</dc:title>
      <dc:creator>OpenClaw</dc:creator>
      <cp:lastModifiedBy>OpenClaw</cp:lastModifiedBy>
      <dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>
      <dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>
    </cp:coreProperties>
    ''')


def app_xml(titles: list[str]) -> str:
    size = len(titles) + 1
    title_parts = '\n'.join(f'        <vt:lpstr>{escape(t)}</vt:lpstr>' for t in ['Office Theme', *titles])
    return xml(f'''
    <Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
      <Application>Microsoft Office PowerPoint</Application>
      <PresentationFormat>On-screen Show (16:9)</PresentationFormat>
      <Slides>{len(titles)}</Slides>
      <Notes>0</Notes>
      <HiddenSlides>0</HiddenSlides>
      <MMClips>0</MMClips>
      <ScaleCrop>false</ScaleCrop>
      <HeadingPairs>
        <vt:vector size="2" baseType="variant">
          <vt:variant><vt:lpstr>Theme</vt:lpstr></vt:variant>
          <vt:variant><vt:i4>1</vt:i4></vt:variant>
        </vt:vector>
      </HeadingPairs>
      <TitlesOfParts>
        <vt:vector size="{size}" baseType="lpstr">
{title_parts}
        </vt:vector>
      </TitlesOfParts>
      <Company></Company>
      <LinksUpToDate>false</LinksUpToDate>
      <SharedDoc>false</SharedDoc>
      <HyperlinksChanged>false</HyperlinksChanged>
      <AppVersion>16.0000</AppVersion>
    </Properties>
    ''')


def presentation_xml(slide_count: int) -> str:
    sld_ids = '\n'.join(
        f'    <p:sldId id="{256 + i}" r:id="rId{i + 2}"/>' for i in range(slide_count)
    )
    return xml(f'''
    <p:presentation xmlns:a="{NS_A}" xmlns:r="{NS_R}" xmlns:p="{NS_P}">
      <p:sldMasterIdLst>
        <p:sldMasterId id="2147483648" r:id="rId1"/>
      </p:sldMasterIdLst>
      <p:sldIdLst>
{sld_ids}
      </p:sldIdLst>
      <p:sldSz cx="{SLIDE_W}" cy="{SLIDE_H}" type="screen16x9"/>
      <p:notesSz cx="6858000" cy="9144000"/>
      <p:defaultTextStyle/>
    </p:presentation>
    ''')


def presentation_rels(slide_count: int) -> str:
    rels = [
        f'  <Relationship Id="rId1" Type="{NS_R}/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
    ]
    rels.extend(
        f'  <Relationship Id="rId{i + 2}" Type="{NS_R}/slide" Target="slides/slide{i + 1}.xml"/>'
        for i in range(slide_count)
    )
    return xml(f'''
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
{chr(10).join(rels)}
    </Relationships>
    ''')


def slide_master_xml() -> str:
    return xml(f'''
    <p:sldMaster xmlns:a="{NS_A}" xmlns:r="{NS_R}" xmlns:p="{NS_P}">
      <p:cSld name="Simple Slide Master">
        <p:bg>
          <p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef>
        </p:bg>
        <p:spTree>
          <p:nvGrpSpPr>
            <p:cNvPr id="1" name=""/>
            <p:cNvGrpSpPr/>
            <p:nvPr/>
          </p:nvGrpSpPr>
          <p:grpSpPr>
            <a:xfrm>
              <a:off x="0" y="0"/>
              <a:ext cx="0" cy="0"/>
              <a:chOff x="0" y="0"/>
              <a:chExt cx="0" cy="0"/>
            </a:xfrm>
          </p:grpSpPr>
        </p:spTree>
      </p:cSld>
      <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
      <p:sldLayoutIdLst>
        <p:sldLayoutId id="1" r:id="rId1"/>
      </p:sldLayoutIdLst>
      <p:txStyles>
        <p:titleStyle/>
        <p:bodyStyle/>
        <p:otherStyle/>
      </p:txStyles>
    </p:sldMaster>
    ''')


def slide_master_rels() -> str:
    return xml(f'''
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="{NS_R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
      <Relationship Id="rId2" Type="{NS_R}/theme" Target="../theme/theme1.xml"/>
    </Relationships>
    ''')


def slide_layout_xml() -> str:
    return xml(f'''
    <p:sldLayout xmlns:a="{NS_A}" xmlns:r="{NS_R}" xmlns:p="{NS_P}" type="blank" preserve="1">
      <p:cSld name="Blank">
        <p:spTree>
          <p:nvGrpSpPr>
            <p:cNvPr id="1" name=""/>
            <p:cNvGrpSpPr/>
            <p:nvPr/>
          </p:nvGrpSpPr>
          <p:grpSpPr>
            <a:xfrm>
              <a:off x="0" y="0"/>
              <a:ext cx="0" cy="0"/>
              <a:chOff x="0" y="0"/>
              <a:chExt cx="0" cy="0"/>
            </a:xfrm>
          </p:grpSpPr>
        </p:spTree>
      </p:cSld>
      <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
    </p:sldLayout>
    ''')


def slide_layout_rels() -> str:
    return xml(f'''
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="{NS_R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
    </Relationships>
    ''')


def theme_xml() -> str:
    return xml(f'''
    <a:theme xmlns:a="{NS_A}" name="Office Theme">
      <a:themeElements>
        <a:clrScheme name="Office">
          <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
          <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
          <a:dk2><a:srgbClr val="1F1F1F"/></a:dk2>
          <a:lt2><a:srgbClr val="F3F6FB"/></a:lt2>
          <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
          <a:accent2><a:srgbClr val="70AD47"/></a:accent2>
          <a:accent3><a:srgbClr val="ED7D31"/></a:accent3>
          <a:accent4><a:srgbClr val="A5A5A5"/></a:accent4>
          <a:accent5><a:srgbClr val="FFC000"/></a:accent5>
          <a:accent6><a:srgbClr val="5B9BD5"/></a:accent6>
          <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
          <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
        </a:clrScheme>
        <a:fontScheme name="Office">
          <a:majorFont>
            <a:latin typeface="Aptos Display"/>
            <a:ea typeface=""/>
            <a:cs typeface=""/>
            <a:font script="Hang" typeface="맑은 고딕"/>
          </a:majorFont>
          <a:minorFont>
            <a:latin typeface="Aptos"/>
            <a:ea typeface=""/>
            <a:cs typeface=""/>
            <a:font script="Hang" typeface="맑은 고딕"/>
          </a:minorFont>
        </a:fontScheme>
        <a:fmtScheme name="Office">
          <a:fillStyleLst>
            <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
            <a:solidFill><a:schemeClr val="accent1"/></a:solidFill>
            <a:solidFill><a:schemeClr val="accent2"/></a:solidFill>
          </a:fillStyleLst>
          <a:lnStyleLst>
            <a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
            <a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
            <a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
          </a:lnStyleLst>
          <a:effectStyleLst>
            <a:effectStyle><a:effectLst/></a:effectStyle>
            <a:effectStyle><a:effectLst/></a:effectStyle>
            <a:effectStyle><a:effectLst/></a:effectStyle>
          </a:effectStyleLst>
          <a:bgFillStyleLst>
            <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
            <a:solidFill><a:schemeClr val="lt1"/></a:solidFill>
            <a:solidFill><a:schemeClr val="lt2"/></a:solidFill>
          </a:bgFillStyleLst>
        </a:fmtScheme>
      </a:themeElements>
      <a:objectDefaults/>
      <a:extraClrSchemeLst/>
    </a:theme>
    ''')


def build() -> None:
    slides = make_slides()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml', content_types(len(slides)))
        zf.writestr('_rels/.rels', root_rels())
        zf.writestr('docProps/core.xml', core_xml())
        zf.writestr('docProps/app.xml', app_xml([title for title, _ in slides]))
        zf.writestr('ppt/presentation.xml', presentation_xml(len(slides)))
        zf.writestr('ppt/_rels/presentation.xml.rels', presentation_rels(len(slides)))
        zf.writestr('ppt/slideMasters/slideMaster1.xml', slide_master_xml())
        zf.writestr('ppt/slideMasters/_rels/slideMaster1.xml.rels', slide_master_rels())
        zf.writestr('ppt/slideLayouts/slideLayout1.xml', slide_layout_xml())
        zf.writestr('ppt/slideLayouts/_rels/slideLayout1.xml.rels', slide_layout_rels())
        zf.writestr('ppt/theme/theme1.xml', theme_xml())
        for idx, (_, slide) in enumerate(slides, start=1):
            zf.writestr(f'ppt/slides/slide{idx}.xml', slide)
            zf.writestr(f'ppt/slides/_rels/slide{idx}.xml.rels', slide_rels_xml())


if __name__ == '__main__':
    build()
    print(OUT)
