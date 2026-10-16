// HWPX package assembly (OCF container): the `mimetype` entry is stored first and uncompressed,
// followed by version/settings, the OPF manifest (Contents/content.hpf), header, section and
// embedded pictures under BinData/. This is a real XML-based HWPX document, not a renamed .hwp.

import { zipSync, strToU8, type Zippable } from 'fflate';
import type { Locale } from '../../shared/i18n';
import type { Conversation } from '../../shared/types';
import { escapeXml, yieldToLoop, type ProgressFn } from '../../shared/util';
import type { ImageStore } from '../images';
import { buildHeaderXml, NS_DECL, ShapeRegistry, XML_DECL } from './header';
import { SectionWriter, type HwpxStats } from './section';

export const HWPX_MIME = 'application/hwp+zip';

export async function buildHwpx(
  conv: Conversation,
  opts: { locale: Locale; images: ImageStore; exportedAt?: number; appVersion?: string; onProgress?: ProgressFn },
): Promise<{ bytes: Uint8Array; stats: HwpxStats }> {
  const exportedAt = opts.exportedAt ?? Date.now();
  const reg = new ShapeRegistry();
  const writer = new SectionWriter(reg, opts.locale, opts.images);
  writer.documentHead(conv, exportedAt);
  const N = conv.messages.length;
  for (let i = 0; i < N; i++) {
    writer.message(conv, conv.messages[i]);
    if (opts.onProgress && i % 50 === 49) {
      opts.onProgress((0.8 * (i + 1)) / N, 'build');
      await yieldToLoop();
    }
  }
  opts.onProgress?.(0.8, 'pack');
  const section = writer.toXml();
  const header = buildHeaderXml(reg);
  const iso = new Date(exportedAt).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const manifestItems = [
    '<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>',
    '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>',
    '<opf:item id="settings" href="settings.xml" media-type="application/xml"/>',
    ...writer.binItems.map((b) => `<opf:item id="${b.id}" href="${b.path}" media-type="${b.mime}" isEmbeded="1"/>`),
  ].join('');

  const contentHpf =
    `${XML_DECL}<opf:package ${NS_DECL} version="" unique-identifier="" id="">` +
    '<opf:metadata>' +
    `<opf:title>${escapeXml(conv.title || conv.siteName)}</opf:title>` +
    `<opf:language>${opts.locale}</opf:language>` +
    '<opf:meta name="creator" content="text">Lucian AI Chat Exporter</opf:meta>' +
    `<opf:meta name="subject" content="text">${escapeXml(conv.siteName)}</opf:meta>` +
    `<opf:meta name="description" content="text">${escapeXml(conv.fromUrl)}</opf:meta>` +
    '<opf:meta name="lastsaveby" content="text">Lucian AI Chat Exporter</opf:meta>' +
    `<opf:meta name="CreatedDate" content="text">${iso}</opf:meta>` +
    `<opf:meta name="ModifiedDate" content="text">${iso}</opf:meta>` +
    '<opf:meta name="keyword" content="text"/>' +
    '</opf:metadata>' +
    `<opf:manifest>${manifestItems}</opf:manifest>` +
    '<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine>' +
    '</opf:package>';

  const version =
    `${XML_DECL}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" ` +
    `major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.5" application="Lucian AI Chat Exporter" appVersion="${escapeXml(opts.appVersion ?? '1.0.0')}"/>`;

  const settings =
    `${XML_DECL}<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0">` +
    '<ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>';

  const container =
    `${XML_DECL}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf">` +
    '<ocf:rootfiles>' +
    '<ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>' +
    '<ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>' +
    '<ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/>' +
    '</ocf:rootfiles></ocf:container>';

  const manifest = `${XML_DECL}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`;

  const rdf =
    `${XML_DECL}<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    '<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/header.xml"/></rdf:Description>' +
    '<rdf:Description rdf:about="Contents/header.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#HeaderFile"/></rdf:Description>' +
    '<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/section0.xml"/></rdf:Description>' +
    '<rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#SectionFile"/></rdf:Description>' +
    '<rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description>' +
    '</rdf:RDF>';

  const preview = (conv.title || '') + '\r\n' + conv.messages.slice(0, 5).map((m) => m.contents.find((c) => c.content)?.content ?? '').join('\r\n');

  const files: Zippable = {
    mimetype: [strToU8(HWPX_MIME), { level: 0 }],
    'version.xml': strToU8(version),
    'Contents/header.xml': strToU8(header),
    'Contents/section0.xml': strToU8(section),
    'Contents/content.hpf': strToU8(contentHpf),
    'settings.xml': strToU8(settings),
    'Preview/PrvText.txt': strToU8(preview.slice(0, 1024)),
    'META-INF/container.xml': strToU8(container),
    'META-INF/manifest.xml': strToU8(manifest),
    'META-INF/container.rdf': strToU8(rdf),
  };
  for (const b of writer.binItems) files[b.path] = [b.bytes, { level: 0 }];
  const bytes = zipSync(files, { level: 6 });
  return { bytes, stats: writer.stats };
}
