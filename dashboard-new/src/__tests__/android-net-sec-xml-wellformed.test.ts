// Regression guard for #969: the Android network_security_config.xml comment
// block contained a literal "--" ("exception -- the system trust anchors"),
// which the XML spec forbids inside <!-- ... --> comments. The debug APK build
// aborted with: ParseError [12,48]: The string "--" is not permitted within
// comments. This guard parses the res/xml files and asserts no comment body
// holds "--", so the fault is caught at the gate instead of at APK build time.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const NET_SEC_XML = resolve(
  process.cwd(),
  'src-tauri/gen/android/app/src/main/res/xml/network_security_config.xml',
)

// Extracts the text between every <!-- and --> so we can assert each comment
// body is XML-legal (no "--" sequence other than the closing delimiter).
function commentBodies(xml: string): string[] {
  const bodies: string[] = []
  const re = /<!--([\s\S]*?)-->/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) bodies.push(m[1])
  return bodies
}

describe('Android network_security_config.xml comments are XML-well-formed (#969)', () => {
  const xml = readFileSync(NET_SEC_XML, 'utf-8')

  it('contains no "--" inside any comment body', () => {
    for (const body of commentBodies(xml)) {
      expect(body).not.toContain('--')
    }
  })

  it('parses as a single well-formed XML document', () => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const parseError = doc.querySelector('parsererror')
    expect(parseError).toBeNull()
    expect(doc.documentElement.tagName).toBe('network-security-config')
  })
})
