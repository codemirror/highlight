import {classHighlightStyle, styleTags, tags as t, highlightTree} from "@codemirror/highlight"
import {buildParser} from "lezer-generator"

const parser = buildParser(`
  @top Program { form* }
  @skip { space | Comment }

  form {
    List { "(" form* ")" } |
    Array { "{" form* "}" } |
    Map { "{{" (Key { Identifier } "=>" form)* "}}" } |
    Tag |
    LocalIdentifier |
    Identifier |
    String
  }

  @skip {} {
    Tag { "<" (plainText | Emphasis)* ">" }
    String { '"' (stringContent | StringEscape)+ '"' }
  }

  @tokens {
    space { std.whitespace+ }
    Comment { ";" ![\\n]* }
    Identifier { $[a-z]+ }
    LocalIdentifier { $[A-Z] $[a-z]* }
    stringContent { !["\\\\]+ }
    StringEscape { "\\\\" _ }
    plainText { ![*>]+ }
    Emphasis { "*" ![*]* "*" }
    "(" ")" "{" "}" "{{" "}}" "=>" "<" ">"
  }
`).configure({
  strict: true,
  props: [styleTags({
    Identifier: t.variableName,
    String: t.string,
    Escape: t.escape,
    "Tag/...": t.literal,
    "Emphasis": t.emphasis,
    "( )": t.paren,
    "{ } {{ }}": t.brace,
    "< >": t.angleBracket,
    "=>": t.definitionOperator,
    "Key/Identifier": t.propertyName,
    "Array!": t.atom,
    Comment: t.comment
  })]
})

function parseSpec(spec: string) {
  let group = /\[([^:]+):[^\]]+\]/g, m
  let content = "", tokens = [], pos = 0
  while (m = group.exec(spec)) {
    content += spec.slice(pos, m.index)
    let rest = spec.slice(m.index + m[1].length + 2, m.index + m[0].length - 1)
    tokens.push({from: content.length, to: content.length + rest.length, token: m[1].split(" ").sort().join(" ")})
    content += rest
    pos = m.index + m[0].length
  }
  content += spec.slice(pos)
  return {content, tokens}
}

function test(name: string, spec: string) {
  it(name, () => {
    let {content, tokens} = parseSpec(spec[0] == "\n" ? spec.slice(1) : spec)
    let tree = parser.parse(content), emit: {from: number, to: number, token: string}[] = []
    highlightTree(tree, classHighlightStyle.match, (from, to, token) => {
      emit.push({from, to, token: token.replace(/\bcmt-/g, "").split(" ").sort().join(" ")})
    })

    function desc(token: {from: number, to: number, token: string}) {
      return `${JSON.stringify(token.token)} for ${JSON.stringify(content.slice(token.from, token.to))}`
    }

    for (let i = 0, j = 0;;) {
      if (i == tokens.length) {
        if (j == emit.length) break
        throw new Error(`Too many tokens (${desc(emit[j])})`)
      } else if (j == emit.length) {
        throw new Error(`Missing token ${desc(tokens[i])}`)
      }
      let nextI = tokens[i++], nextJ = emit[j++]
      if (nextI.from != nextJ.from || nextI.to != nextJ.to || nextI.token != nextJ.token)
        throw new Error(`Got ${desc(nextJ)} but expected ${desc(nextI)}`)
    }
  })
}

describe("highlighting", () => {
  test("Styles basic tokens", `[punctuation:(][string:"hello"] [variableName:world][punctuation:)]`)

  test("styles opaque nodes", `[atom:{one two "three"}]`)

  test("adds inherited tags", `[punctuation literal:<][literal:foo][literal emphasis:*bar*][punctuation literal:>]`)

  test("supports hierarchical selectors", `[punctuation:{{][propertyName:foo] [operator:=>] [variableName:bar][punctuation:}}]`)
})
