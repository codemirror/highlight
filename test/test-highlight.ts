import {classHighlightStyle, HighlightStyle, Tag, styleTags, tags as t, highlightTree} from "@codemirror/highlight"
import {NodeType, Parser, parseMixed} from "@lezer/common"
import {buildParser} from "@lezer/generator"

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
    StringEscape: t.escape,
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

let wrapper = buildParser(`
@top Wrap { ("<<" Content ">>" | Interpolation)* }
Interpolation { "{" (dots | "{" InterpolationContent "}")* "}" }
@tokens {
  Content { ![>]+ }
  InterpolationContent { ![}]+ }
  dots { "."+ }
  "<<" ">>" "{" "}"
}`).configure({
  strict: true,
  props: [styleTags({
    "<< >>": t.angleBracket,
    "{ }": t.brace
  })],
  wrap: parseMixed(node => {
    return node.name == "Content" ? {parser}
      :  node.name == "Interpolation" ? {parser, overlay: c => c.name == "InterpolationContent"}
      : null
  })
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

function test(name: string, spec: string, {parse = parser, highlight = classHighlightStyle.match}: {
  parse?: Parser,
  highlight?: (tag: Tag, scope: NodeType) => string | null
} = {}) {
  it(name, () => {
    let {content, tokens} = parseSpec(spec[0] == "\n" ? spec.slice(1) : spec)
    let tree = parse.parse(content), emit: {from: number, to: number, token: string}[] = []
    highlightTree(tree, highlight, (from, to, token) => {
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

  test("innermost tags take precedence", `[string:"hell][string2:\\o][string:"]`)

  test("styles opaque nodes", `[atom:{one two "three"}]`)

  test("adds inherited tags", `[punctuation literal:<][literal:foo][literal emphasis:*bar*][punctuation literal:>]`)

  test("supports hierarchical selectors", `[punctuation:{{][propertyName:foo] [operator:=>] [variableName:bar][punctuation:}}]`)

  test("can specialize highlighters per language", `[outerPunc:<<]([innerVar:hello])[outerPunc:>>]`, {
    parse: wrapper,
    highlight: HighlightStyle.combinedMatch([
      HighlightStyle.define([{tag: t.punctuation, class: "outerPunc"}], {scope: wrapper.topNode}),
      HighlightStyle.define([{tag: t.variableName, class: "innerVar"}], {scope: parser.topNode})
    ])
  })

  test("can use language-wide styles", `[outer punctuation:<<][inner string:"wow"][outer punctuation:>>]`, {
    parse: wrapper,
    highlight: HighlightStyle.combinedMatch([
      classHighlightStyle,
      HighlightStyle.define([], {scope: wrapper.topNode, all: "outer"}),
      HighlightStyle.define([], {scope: parser.topNode, all: "inner"})
    ])
  })

  test("can highlight overlays",
       `[punctuation:{]...[punctuation:{][string:"foo][punctuation:}]..[punctuation:{][string:bar"] [variableName:x][punctuation:}].[punctuation:}]`,
       {parse: wrapper})
})

