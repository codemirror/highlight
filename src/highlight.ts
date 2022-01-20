import {Tree, NodeType, NodeProp, TreeCursor} from "@lezer/common"
import {StyleSpec, StyleModule} from "style-mod"
import {EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet} from "@codemirror/view"
import {EditorState, Extension, Prec, Facet} from "@codemirror/state"
import {syntaxTree} from "@codemirror/language"
import {RangeSetBuilder} from "@codemirror/rangeset"

let nextTagID = 0

/// Highlighting tags are markers that denote a highlighting category.
/// They are [associated](#highlight.styleTags) with parts of a syntax
/// tree by a language mode, and then mapped to an actual CSS style by
/// a [highlight style](#highlight.HighlightStyle).
///
/// Because syntax tree node types and highlight styles have to be
/// able to talk the same language, CodeMirror uses a mostly _closed_
/// [vocabulary](#highlight.tags) of syntax tags (as opposed to
/// traditional open string-based systems, which make it hard for
/// highlighting themes to cover all the tokens produced by the
/// various languages).
///
/// It _is_ possible to [define](#highlight.Tag^define) your own
/// highlighting tags for system-internal use (where you control both
/// the language package and the highlighter), but such tags will not
/// be picked up by regular highlighters (though you can derive them
/// from standard tags to allow highlighters to fall back to those).
export class Tag {
  /// @internal
  id = nextTagID++

  /// @internal
  constructor(
    /// The set of tags that match this tag, starting with this one
    /// itself, sorted in order of decreasing specificity. @internal
    readonly set: Tag[],
    /// The base unmodified tag that this one is based on, if it's
    /// modified @internal
    readonly base: Tag | null,
    /// The modifiers applied to this.base @internal
    readonly modified: readonly Modifier[]
  ) {}

  /// Define a new tag. If `parent` is given, the tag is treated as a
  /// sub-tag of that parent, and [highlight
  /// styles](#highlight.HighlightStyle) that don't mention this tag
  /// will try to fall back to the parent tag (or grandparent tag,
  /// etc).
  static define(parent?: Tag): Tag {
    if (parent?.base) throw new Error("Can not derive from a modified tag")
    let tag = new Tag([], null, [])
    tag.set.push(tag)
    if (parent) for (let t of parent.set) tag.set.push(t)
    return tag
  }

  /// Define a tag _modifier_, which is a function that, given a tag,
  /// will return a tag that is a subtag of the original. Applying the
  /// same modifier to a twice tag will return the same value (`m1(t1)
  /// == m1(t1)`) and applying multiple modifiers will, regardless or
  /// order, produce the same tag (`m1(m2(t1)) == m2(m1(t1))`).
  ///
  /// When multiple modifiers are applied to a given base tag, each
  /// smaller set of modifiers is registered as a parent, so that for
  /// example `m1(m2(m3(t1)))` is a subtype of `m1(m2(t1))`,
  /// `m1(m3(t1)`, and so on.
  static defineModifier(): (tag: Tag) => Tag {
    let mod = new Modifier
    return (tag: Tag) => {
      if (tag.modified.indexOf(mod) > -1) return tag
      return Modifier.get(tag.base || tag, tag.modified.concat(mod).sort((a, b) => a.id - b.id))
    }
  }
}

let nextModifierID = 0

class Modifier {
  instances: Tag[] = []
  id = nextModifierID++

  static get(base: Tag, mods: readonly Modifier[]) {
    if (!mods.length) return base
    let exists = mods[0].instances.find(t => t.base == base && sameArray(mods, t.modified))
    if (exists) return exists
    let set: Tag[] = [], tag = new Tag(set, base, mods)
    for (let m of mods) m.instances.push(tag)
    let configs = permute(mods)
    for (let parent of base.set) for (let config of configs)
      set.push(Modifier.get(parent, config))
    return tag
  }
}

function sameArray<T>(a: readonly T[], b: readonly T[]) {
  return a.length == b.length && a.every((x, i) => x == b[i])
}

function permute<T>(array: readonly T[]): (readonly T[])[] {
  let result = [array]
  for (let i = 0; i < array.length; i++) {
    for (let a of permute(array.slice(0, i).concat(array.slice(i + 1)))) result.push(a)
  }
  return result
}

/// This function is used to add a set of tags to a language syntax
/// via
/// [`LRParser.configure`](https://lezer.codemirror.net/docs/ref#lr.LRParser.configure).
///
/// The argument object maps node selectors to [highlighting
/// tags](#highlight.Tag) or arrays of tags.
///
/// Node selectors may hold one or more (space-separated) node paths.
/// Such a path can be a [node
/// name](https://lezer.codemirror.net/docs/ref#common.NodeType.name),
/// or multiple node names (or `*` wildcards) separated by slash
/// characters, as in `"Block/Declaration/VariableName"`. Such a path
/// matches the final node but only if its direct parent nodes are the
/// other nodes mentioned. A `*` in such a path matches any parent,
/// but only a single level—wildcards that match multiple parents
/// aren't supported, both for efficiency reasons and because Lezer
/// trees make it rather hard to reason about what they would match.)
///
/// A path can be ended with `/...` to indicate that the tag assigned
/// to the node should also apply to all child nodes, even if they
/// match their own style (by default, only the innermost style is
/// used).
///
/// When a path ends in `!`, as in `Attribute!`, no further matching
/// happens for the node's child nodes, and the entire node gets the
/// given style.
///
/// In this notation, node names that contain `/`, `!`, `*`, or `...`
/// must be quoted as JSON strings.
///
/// For example:
///
/// ```javascript
/// parser.withProps(
///   styleTags({
///     // Style Number and BigNumber nodes
///     "Number BigNumber": tags.number,
///     // Style Escape nodes whose parent is String
///     "String/Escape": tags.escape,
///     // Style anything inside Attributes nodes
///     "Attributes!": tags.meta,
///     // Add a style to all content inside Italic nodes
///     "Italic/...": tags.emphasis,
///     // Style InvalidString nodes as both `string` and `invalid`
///     "InvalidString": [tags.string, tags.invalid],
///     // Style the node named "/" as punctuation
///     '"/"': tags.punctuation
///   })
/// )
/// ```
export function styleTags(spec: {[selector: string]: Tag | readonly Tag[]}) {
  let byName: {[name: string]: Rule} = Object.create(null)
  for (let prop in spec) {
    let tags = spec[prop]
    if (!Array.isArray(tags)) tags = [tags as Tag]
    for (let part of prop.split(" ")) if (part) {
      let pieces: (string | null)[] = [], mode = Mode.Normal, rest = part
      for (let pos = 0;;) {
        if (rest == "..." && pos > 0 && pos + 3 == part.length) { mode = Mode.Inherit; break }
        let m = /^"(?:[^"\\]|\\.)*?"|[^\/!]+/.exec(rest)
        if (!m) throw new RangeError("Invalid path: " + part)
        pieces.push(m[0] == "*" ? null : m[0][0] == '"' ? JSON.parse(m[0]) : m[0])
        pos += m[0].length
        if (pos == part.length) break
        let next = part[pos++]
        if (pos == part.length && next == "!") { mode = Mode.Opaque; break }
        if (next != "/") throw new RangeError("Invalid path: " + part)
        rest = part.slice(pos)
      }
      let last = pieces.length - 1, inner = pieces[last]
      if (!inner) throw new RangeError("Invalid path: " + part)
      let rule = new Rule(tags, mode, last > 0 ? pieces.slice(0, last) : null)
      byName[inner] = rule.sort(byName[inner])
    }
  }
  return ruleNodeProp.add(byName)
}

const ruleNodeProp = new NodeProp<Rule>()

const highlightStyle = Facet.define<HighlightStyle, ((tag: Tag, scope: NodeType) => string | null) | null>({
  combine(stylings) { return stylings.length ? HighlightStyle.combinedMatch(stylings) : null }
})

const fallbackHighlightStyle = Facet.define<HighlightStyle, ((tag: Tag, scope: NodeType) => string | null) | null>({
  combine(values) { return values.length ? values[0].match : null }
})

function getHighlightStyle(state: EditorState): ((tag: Tag, scope: NodeType) => string | null) | null {
  return state.facet(highlightStyle) || state.facet(fallbackHighlightStyle)
}

const enum Mode { Opaque, Inherit, Normal }

class Rule {
  constructor(readonly tags: readonly Tag[],
              readonly mode: Mode,
              readonly context: readonly (string | null)[] | null,
              public next?: Rule) {}

  sort(other: Rule | undefined) {
    if (!other || other.depth < this.depth) {
      this.next = other
      return this
    }
    other.next = this.sort(other.next)
    return other
  }

  get depth() { return this.context ? this.context.length : 0 }
}

/// A highlight style associates CSS styles with higlighting
/// [tags](#highlight.Tag).
export class HighlightStyle {
  /// Extension that registers this style with an editor. When
  /// multiple highlight styles are given, they _all_ apply, assigning
  /// the combination of their matching styles to tokens.
  readonly extension: Extension

  /// An extension that installs this highlighter as a fallback
  /// highlight style, which will only be used if no other highlight
  /// styles are configured.
  readonly fallback: Extension

  /// A style module holding the CSS rules for this highlight style.
  /// When using [`highlightTree`](#highlight.highlightTree), you may
  /// want to manually mount this module to show the highlighting.
  readonly module: StyleModule | null

  private map: {[tagID: number]: string | null} = Object.create(null)
  private scope: NodeType | null
  private all: string | null 

  private constructor(spec: readonly TagStyle[],
                      options: {scope?: NodeType, all?: string | StyleSpec, themeType?: "dark" | "light"}) {
    let modSpec: {[name: string]: StyleSpec} | undefined
    function def(spec: StyleSpec) {
      let cls = StyleModule.newName()
      ;(modSpec || (modSpec = Object.create(null)))["." + cls] = spec
      return cls
    }
    this.all = typeof options.all == "string" ? options.all : options.all ? def(options.all) : null

    for (let style of spec) {
      let cls = (style.class as string || def(Object.assign({}, style, {tag: null}))) +
        (this.all ? " " + this.all : "")
      let tags = style.tag
      if (!Array.isArray(tags)) this.map[(tags as Tag).id] = cls
      else for (let tag of tags) this.map[tag.id] = cls
    }

    this.module = modSpec ? new StyleModule(modSpec) : null
    this.scope = options.scope || null
    this.match = this.match.bind(this)
    let ext = [treeHighlighter]
    if (this.module) ext.push(EditorView.styleModule.of(this.module))
    this.extension = ext.concat(options.themeType == null ? highlightStyle.of(this) :
      highlightStyle.computeN([EditorView.darkTheme], state => {
        return state.facet(EditorView.darkTheme) == (options.themeType == "dark") ? [this] : []
      }))
    this.fallback = ext.concat(fallbackHighlightStyle.of(this))
  }

  /// Returns the CSS class associated with the given tag, if any.
  /// This method is bound to the instance by the constructor.
  match(tag: Tag, scope: NodeType) {
    if (this.scope && scope != this.scope) return null
    for (let t of tag.set) {
      let match = this.map[t.id]
      if (match !== undefined) {
        if (t != tag) this.map[tag.id] = match
        return match
      }
    }
    return this.map[tag.id] = this.all
  }

  /// Combines an array of highlight styles into a single match
  /// function that returns all of the classes assigned by the styles
  /// for a given tag.
  static combinedMatch(styles: readonly HighlightStyle[]) {
    if (styles.length == 1) return styles[0].match
    let cache = styles.some(s => s.scope) ? undefined : Object.create(null)
    return (tag: Tag, scope: NodeType) => {
      let cached = cache && cache[tag.id]
      if (cached !== undefined) return cached
      let result = null
      for (let style of styles) {
        let value = style.match(tag, scope)
        if (value) result = result ? result + " " + value : value
      }
      if (cache) cache[tag.id] = result
      return result
    }
  }

  /// Create a highlighter style that associates the given styles to
  /// the given tags. The spec must be objects that hold a style tag
  /// or array of tags in their `tag` property, and either a single
  /// `class` property providing a static CSS class (for highlighters
  /// like [`classHighlightStyle`](#highlight.classHighlightStyle)
  /// that rely on external styling), or a
  /// [`style-mod`](https://github.com/marijnh/style-mod#documentation)-style
  /// set of CSS properties (which define the styling for those tags).
  ///
  /// The CSS rules created for a highlighter will be emitted in the
  /// order of the spec's properties. That means that for elements that
  /// have multiple tags associated with them, styles defined further
  /// down in the list will have a higher CSS precedence than styles
  /// defined earlier.
  static define(specs: readonly TagStyle[], options?: {
    /// By default, highlighters apply to the entire document. You can
    /// scope them to a single language by providing the language's
    /// [top node](#language.Language.topNode) here.
    scope?: NodeType,
    /// Add a style to _all_ content. Probably only useful in
    /// combination with `scope`.
    all?: string | StyleSpec,
    /// Specify that this highlight style should only be active then
    /// the theme is dark or light. By default, it is active
    /// regardless of theme.
    themeType?: "dark" | "light"
  }) {
    return new HighlightStyle(specs, options || {})
  }

  /// Returns the CSS classes (if any) that the highlight styles
  /// active in the given state would assign to the given a style
  /// [tag](#highlight.Tag) and (optional) language
  /// [scope](#highlight.HighlightStyle^define^options.scope).
  static get(state: EditorState, tag: Tag, scope?: NodeType) {
    let style = getHighlightStyle(state)
    return style && style(tag, scope || NodeType.none)
  }
}

/// The type of object used in
/// [`HighlightStyle.define`](#highlight.HighlightStyle^define).
/// Assigns a style to one or more highlighting
/// [tags](#highlight.Tag), which can either be a fixed class name
/// (which must be defined elsewhere), or a set of CSS properties, for
/// which the library will define an anonymous class.
export interface TagStyle {
  /// The tag or tags to target.
  tag: Tag | readonly Tag[],
  /// If given, this maps the tags to a fixed class name.
  class?: string,
  /// Any further properties (if `class` isn't given) will be
  /// interpreted as in style objects given to
  /// [style-mod](https://github.com/marijnh/style-mod#documentation).
  /// The type here is `any` because of TypeScript limitations.
  [styleProperty: string]: any
}

/// Run the tree highlighter over the given tree.
export function highlightTree(
  tree: Tree,
  /// Get the CSS classes used to style a given [tag](#highlight.Tag),
  /// or `null` if it isn't styled. (You'll often want to pass a
  /// highlight style's [`match`](#highlight.HighlightStyle.match)
  /// method here.)
  getStyle: (tag: Tag, scope: NodeType) => string | null,
  /// Assign styling to a region of the text. Will be called, in order
  /// of position, for any ranges where more than zero classes apply.
  /// `classes` is a space separated string of CSS classes.
  putStyle: (from: number, to: number, classes: string) => void,
  /// The start of the range to highlight.
  from = 0,
  /// The end of the range.
  to = tree.length,
) {
  highlightTreeRange(tree, from, to, getStyle, putStyle)
}

class TreeHighlighter {
  decorations: DecorationSet
  tree: Tree
  markCache: {[cls: string]: Decoration} = Object.create(null)

  constructor(view: EditorView) {
    this.tree = syntaxTree(view.state)
    this.decorations = this.buildDeco(view, getHighlightStyle(view.state))
  }

  update(update: ViewUpdate) {
    let tree = syntaxTree(update.state), style = getHighlightStyle(update.state)
    let styleChange = style != update.startState.facet(highlightStyle)
    if (tree.length < update.view.viewport.to && !styleChange && tree.type == this.tree.type) {
      this.decorations = this.decorations.map(update.changes)
    } else if (tree != this.tree || update.viewportChanged || styleChange) {
      this.tree = tree
      this.decorations = this.buildDeco(update.view, style)
    }
  }

  buildDeco(view: EditorView, match: ((tag: Tag, scope: NodeType) => string | null) | null) {
    if (!match || !this.tree.length) return Decoration.none

    let builder = new RangeSetBuilder<Decoration>()
    for (let {from, to} of view.visibleRanges) {
      highlightTreeRange(this.tree, from, to, match, (from, to, style) => {
        builder.add(from, to, this.markCache[style] || (this.markCache[style] = Decoration.mark({class: style})))
      })
    }
    return builder.finish()
  }
}

// This extension installs a highlighter that highlights based on the
// syntax tree and highlight style.
const treeHighlighter = Prec.high(ViewPlugin.fromClass(TreeHighlighter, {
  decorations: v => v.decorations
}))

const nodeStack = [""]

class HighlightBuilder {
  class = ""
  constructor(
    public at: number,
    readonly style: (tag: Tag, scope: NodeType) => string | null,
    readonly span: (from: number, to: number, cls: string) => void
  ) {}

  startSpan(at: number, cls: string) {
    if (cls != this.class) {
      this.flush(at)
      if (at > this.at) this.at = at
      this.class = cls
    }
  }

  flush(to: number) {
    if (to > this.at && this.class) this.span(this.at, to, this.class)
  }

  highlightRange(cursor: TreeCursor, from: number, to: number, inheritedClass: string, depth: number, scope: NodeType) {
    let {type, from: start, to: end} = cursor
    if (start >= to || end <= from) return
    nodeStack[depth] = type.name
    if (type.isTop) scope = type

    let cls = inheritedClass
    let rule = type.prop(ruleNodeProp), opaque = false
    while (rule) {
      if (!rule.context || matchContext(rule.context, nodeStack, depth)) {
        for (let tag of rule.tags) {
          let st = this.style(tag, scope)
          if (st) {
            if (cls) cls += " "
            cls += st
            if (rule.mode == Mode.Inherit) inheritedClass += (inheritedClass ? " " : "") + st
            else if (rule.mode == Mode.Opaque) opaque = true
          }
        }
        break
      }
      rule = rule.next
    }

    this.startSpan(cursor.from, cls)
    if (opaque) return

    let mounted = cursor.tree && cursor.tree.prop(NodeProp.mounted)
    if (mounted && mounted.overlay) {
      let inner = cursor.node.enter(mounted.overlay[0].from + start, 1)!
      let hasChild = cursor.firstChild()
      for (let i = 0, pos = start;; i++) {
        let next = i < mounted.overlay.length ? mounted.overlay[i] : null
        let nextPos = next ? next.from + start : end
        let rangeFrom = Math.max(from, pos), rangeTo = Math.min(to, nextPos)
        if (rangeFrom < rangeTo && hasChild) {
          while (cursor.from < rangeTo) {
            this.highlightRange(cursor, rangeFrom, rangeTo, inheritedClass, depth + 1, scope)
            this.startSpan(Math.min(to, cursor.to), cls)
            if (cursor.to >= nextPos || !cursor.nextSibling()) break
          }
        }
        if (!next || nextPos > to) break
        pos = next.to + start
        if (pos > from) {
          this.highlightRange(inner.cursor, Math.max(from, next.from + start), Math.min(to, pos),
                              inheritedClass, depth, mounted.tree.type)
          this.startSpan(pos, cls)
        }
      }
      if (hasChild) cursor.parent()
    } else if (cursor.firstChild()) {
      do {
        if (cursor.to <= from) continue
        if (cursor.from >= to) break
        this.highlightRange(cursor, from, to, inheritedClass, depth + 1, scope)
        this.startSpan(Math.min(to, cursor.to), cls)
      } while (cursor.nextSibling())
      cursor.parent()
    }
  }
}

function highlightTreeRange(tree: Tree, from: number, to: number,
                            style: (tag: Tag, scope: NodeType) => string | null,
                            span: (from: number, to: number, cls: string) => void) {
  let builder = new HighlightBuilder(from, style, span)
  builder.highlightRange(tree.cursor(), from, to, "", 0, tree.type)
  builder.flush(to)
}

function matchContext(context: readonly (null | string)[], stack: readonly string[], depth: number) {
  if (context.length > depth - 1) return false
  for (let d = depth - 1, i = context.length - 1; i >= 0; i--, d--) {
    let check = context[i]
    if (check && check != stack[d]) return false
  }
  return true
}

const t = Tag.define

const comment = t(), name = t(), typeName = t(name), propertyName = t(name),
  literal = t(), string = t(literal), number = t(literal),
  content = t(), heading = t(content), keyword = t(), operator = t(),
  punctuation = t(), bracket = t(punctuation), meta = t()

/// The default set of highlighting [tags](#highlight.Tag^define) used
/// by regular language packages and themes.
///
/// This collection is heavily biased towards programming languages,
/// and necessarily incomplete. A full ontology of syntactic
/// constructs would fill a stack of books, and be impractical to
/// write themes for. So try to make do with this set. If all else
/// fails, [open an
/// issue](https://github.com/codemirror/codemirror.next) to propose a
/// new tag, or [define](#highlight.Tag^define) a local custom tag for
/// your use case.
///
/// Note that it is not obligatory to always attach the most specific
/// tag possible to an element—if your grammar can't easily
/// distinguish a certain type of element (such as a local variable),
/// it is okay to style it as its more general variant (a variable).
/// 
/// For tags that extend some parent tag, the documentation links to
/// the parent.
export const tags = {
  /// A comment.
  comment,
  /// A line [comment](#highlight.tags.comment).
  lineComment: t(comment),
  /// A block [comment](#highlight.tags.comment).
  blockComment: t(comment),
  /// A documentation [comment](#highlight.tags.comment).
  docComment: t(comment),

  /// Any kind of identifier.
  name,
  /// The [name](#highlight.tags.name) of a variable.
  variableName: t(name),
  /// A type [name](#highlight.tags.name).
  typeName: typeName,
  /// A tag name (subtag of [`typeName`](#highlight.tags.typeName)).
  tagName: t(typeName),
  /// A property or field [name](#highlight.tags.name).
  propertyName: propertyName,
  /// An attribute name (subtag of [`propertyName`](#highlight.tags.propertyName)).
  attributeName: t(propertyName),
  /// The [name](#highlight.tags.name) of a class.
  className: t(name),
  /// A label [name](#highlight.tags.name).
  labelName: t(name),
  /// A namespace [name](#highlight.tags.name).
  namespace: t(name),
  /// The [name](#highlight.tags.name) of a macro.
  macroName: t(name),

  /// A literal value.
  literal,
  /// A string [literal](#highlight.tags.literal).
  string,
  /// A documentation [string](#highlight.tags.string).
  docString: t(string),
  /// A character literal (subtag of [string](#highlight.tags.string)).
  character: t(string),
  /// An attribute value (subtag of [string](#highlight.tags.string)).
  attributeValue: t(string),
  /// A number [literal](#highlight.tags.literal).
  number,
  /// An integer [number](#highlight.tags.number) literal.
  integer: t(number),
  /// A floating-point [number](#highlight.tags.number) literal.
  float: t(number),
  /// A boolean [literal](#highlight.tags.literal).
  bool: t(literal),
  /// Regular expression [literal](#highlight.tags.literal).
  regexp: t(literal),
  /// An escape [literal](#highlight.tags.literal), for example a
  /// backslash escape in a string.
  escape: t(literal),
  /// A color [literal](#highlight.tags.literal).
  color: t(literal),
  /// A URL [literal](#highlight.tags.literal).
  url: t(literal),

  /// A language keyword.
  keyword,
  /// The [keyword](#highlight.tags.keyword) for the self or this
  /// object.
  self: t(keyword),
  /// The [keyword](#highlight.tags.keyword) for null.
  null: t(keyword),
  /// A [keyword](#highlight.tags.keyword) denoting some atomic value.
  atom: t(keyword),
  /// A [keyword](#highlight.tags.keyword) that represents a unit.
  unit: t(keyword),
  /// A modifier [keyword](#highlight.tags.keyword).
  modifier: t(keyword),
  /// A [keyword](#highlight.tags.keyword) that acts as an operator.
  operatorKeyword: t(keyword),
  /// A control-flow related [keyword](#highlight.tags.keyword).
  controlKeyword: t(keyword),
  /// A [keyword](#highlight.tags.keyword) that defines something.
  definitionKeyword: t(keyword),
  /// A [keyword](#highlight.tags.keyword) related to defining or
  /// interfacing with modules.
  moduleKeyword: t(keyword),

  /// An operator.
  operator,
  /// An [operator](#highlight.tags.operator) that defines something.
  derefOperator: t(operator),
  /// Arithmetic-related [operator](#highlight.tags.operator).
  arithmeticOperator: t(operator),
  /// Logical [operator](#highlight.tags.operator).
  logicOperator: t(operator),
  /// Bit [operator](#highlight.tags.operator).
  bitwiseOperator: t(operator),
  /// Comparison [operator](#highlight.tags.operator).
  compareOperator: t(operator),
  /// [Operator](#highlight.tags.operator) that updates its operand.
  updateOperator: t(operator),
  /// [Operator](#highlight.tags.operator) that defines something.
  definitionOperator: t(operator),
  /// Type-related [operator](#highlight.tags.operator).
  typeOperator: t(operator),
  /// Control-flow [operator](#highlight.tags.operator).
  controlOperator: t(operator),

  /// Program or markup punctuation.
  punctuation,
  /// [Punctuation](#highlight.tags.punctuation) that separates
  /// things.
  separator: t(punctuation),
  /// Bracket-style [punctuation](#highlight.tags.punctuation).
  bracket,
  /// Angle [brackets](#highlight.tags.bracket) (usually `<` and `>`
  /// tokens).
  angleBracket: t(bracket),
  /// Square [brackets](#highlight.tags.bracket) (usually `[` and `]`
  /// tokens).
  squareBracket: t(bracket),
  /// Parentheses (usually `(` and `)` tokens). Subtag of
  /// [bracket](#highlight.tags.bracket).
  paren: t(bracket),
  /// Braces (usually `{` and `}` tokens). Subtag of
  /// [bracket](#highlight.tags.bracket).
  brace: t(bracket),

  /// Content, for example plain text in XML or markup documents.
  content,
  /// [Content](#highlight.tags.content) that represents a heading.
  heading,
  /// A level 1 [heading](#highlight.tags.heading).
  heading1: t(heading),
  /// A level 2 [heading](#highlight.tags.heading).
  heading2: t(heading),
  /// A level 3 [heading](#highlight.tags.heading).
  heading3: t(heading),
  /// A level 4 [heading](#highlight.tags.heading).
  heading4: t(heading),
  /// A level 5 [heading](#highlight.tags.heading).
  heading5: t(heading),
  /// A level 6 [heading](#highlight.tags.heading).
  heading6: t(heading),
  /// A prose separator (such as a horizontal rule).
  contentSeparator: t(content),
  /// [Content](#highlight.tags.content) that represents a list.
  list: t(content),
  /// [Content](#highlight.tags.content) that represents a quote.
  quote: t(content),
  /// [Content](#highlight.tags.content) that is emphasized.
  emphasis: t(content),
  /// [Content](#highlight.tags.content) that is styled strong.
  strong: t(content),
  /// [Content](#highlight.tags.content) that is part of a link.
  link: t(content),
  /// [Content](#highlight.tags.content) that is styled as code or
  /// monospace.
  monospace: t(content),
  /// [Content](#highlight.tags.content) that has a strike-through
  /// style.
  strikethrough: t(content),

  /// Inserted text in a change-tracking format.
  inserted: t(),
  /// Deleted text.
  deleted: t(),
  /// Changed text.
  changed: t(),

  /// An invalid or unsyntactic element.
  invalid: t(),

  /// Metadata or meta-instruction.
  meta,
  /// [Metadata](#highlight.tags.meta) that applies to the entire
  /// document.
  documentMeta: t(meta),
  /// [Metadata](#highlight.tags.meta) that annotates or adds
  /// attributes to a given syntactic element.
  annotation: t(meta),
  /// Processing instruction or preprocessor directive. Subtag of
  /// [meta](#highlight.tags.meta).
  processingInstruction: t(meta),

  /// [Modifier](#highlight.Tag^defineModifier) that indicates that a
  /// given element is being defined. Expected to be used with the
  /// various [name](#highlight.tags.name) tags.
  definition: Tag.defineModifier(),
  /// [Modifier](#highlight.Tag^defineModifier) that indicates that
  /// something is constant. Mostly expected to be used with
  /// [variable names](#highlight.tags.variableName).
  constant: Tag.defineModifier(),
  /// [Modifier](#highlight.Tag^defineModifier) used to indicate that
  /// a [variable](#highlight.tags.variableName) or [property
  /// name](#highlight.tags.propertyName) is being called or defined
  /// as a function.
  function: Tag.defineModifier(),
  /// [Modifier](#highlight.Tag^defineModifier) that can be applied to
  /// [names](#highlight.tags.name) to indicate that they belong to
  /// the language's standard environment.
  standard: Tag.defineModifier(),
  /// [Modifier](#highlight.Tag^defineModifier) that indicates a given
  /// [names](#highlight.tags.name) is local to some scope.
  local: Tag.defineModifier(),

  /// A generic variant [modifier](#highlight.Tag^defineModifier) that
  /// can be used to tag language-specific alternative variants of
  /// some common tag. It is recommended for themes to define special
  /// forms of at least the [string](#highlight.tags.string) and
  /// [variable name](#highlight.tags.variableName) tags, since those
  /// come up a lot.
  special: Tag.defineModifier()
}

/// A default highlight style (works well with light themes).
export const defaultHighlightStyle = HighlightStyle.define([
  {tag: tags.link,
   textDecoration: "underline"},
  {tag: tags.heading,
   textDecoration: "underline",
   fontWeight: "bold"},
  {tag: tags.emphasis,
   fontStyle: "italic"},
  {tag: tags.strong,
   fontWeight: "bold"},
  {tag: tags.strikethrough,
   textDecoration: "line-through"},
  {tag: tags.keyword,
   color: "#708"},
  {tag: [tags.atom, tags.bool, tags.url, tags.contentSeparator, tags.labelName],
   color: "#219"},
  {tag: [tags.literal, tags.inserted],
   color: "#164"},
  {tag: [tags.string, tags.deleted],
   color: "#a11"},
  {tag: [tags.regexp, tags.escape, tags.special(tags.string)],
   color: "#e40"},
  {tag: tags.definition(tags.variableName),
   color: "#00f"},
  {tag: tags.local(tags.variableName),
   color: "#30a"},
  {tag: [tags.typeName, tags.namespace],
   color: "#085"},
  {tag: tags.className,
   color: "#167"},
  {tag: [tags.special(tags.variableName), tags.macroName],
   color: "#256"},
  {tag: tags.definition(tags.propertyName),
   color: "#00c"},
  {tag: tags.comment,
   color: "#940"},
  {tag: tags.meta,
   color: "#7a757a"},
  {tag: tags.invalid,
   color: "#f00"}
])

/// This is a highlight style that adds stable, predictable classes to
/// tokens, for styling with external CSS.
///
/// These tags are mapped to their name prefixed with `"cmt-"` (for
/// example `"cmt-comment"`):
///
/// * [`link`](#highlight.tags.link)
/// * [`heading`](#highlight.tags.heading)
/// * [`emphasis`](#highlight.tags.emphasis)
/// * [`strong`](#highlight.tags.strong)
/// * [`keyword`](#highlight.tags.keyword)
/// * [`atom`](#highlight.tags.atom)
/// * [`bool`](#highlight.tags.bool)
/// * [`url`](#highlight.tags.url)
/// * [`labelName`](#highlight.tags.labelName)
/// * [`inserted`](#highlight.tags.inserted)
/// * [`deleted`](#highlight.tags.deleted)
/// * [`literal`](#highlight.tags.literal)
/// * [`string`](#highlight.tags.string)
/// * [`number`](#highlight.tags.number)
/// * [`variableName`](#highlight.tags.variableName)
/// * [`typeName`](#highlight.tags.typeName)
/// * [`namespace`](#highlight.tags.namespace)
/// * [`className`](#highlight.tags.className)
/// * [`macroName`](#highlight.tags.macroName)
/// * [`propertyName`](#highlight.tags.propertyName)
/// * [`operator`](#highlight.tags.operator)
/// * [`comment`](#highlight.tags.comment)
/// * [`meta`](#highlight.tags.meta)
/// * [`punctuation`](#highlight.tags.puncutation)
/// * [`invalid`](#highlight.tags.invalid)
///
/// In addition, these mappings are provided:
///
/// * [`regexp`](#highlight.tags.regexp),
///   [`escape`](#highlight.tags.escape), and
///   [`special`](#highlight.tags.special)[`(string)`](#highlight.tags.string)
///   are mapped to `"cmt-string2"`
/// * [`special`](#highlight.tags.special)[`(variableName)`](#highlight.tags.variableName)
///   to `"cmt-variableName2"`
/// * [`local`](#highlight.tags.local)[`(variableName)`](#highlight.tags.variableName)
///   to `"cmt-variableName cmt-local"`
/// * [`definition`](#highlight.tags.definition)[`(variableName)`](#highlight.tags.variableName)
///   to `"cmt-variableName cmt-definition"`
/// * [`definition`](#highlight.tags.definition)[`(propertyName)`](#highlight.tags.propertyName)
///   to `"cmt-propertyName cmt-definition"`
export const classHighlightStyle = HighlightStyle.define([
  {tag: tags.link, class: "cmt-link"},
  {tag: tags.heading, class: "cmt-heading"},
  {tag: tags.emphasis, class: "cmt-emphasis"},
  {tag: tags.strong, class: "cmt-strong"},
  {tag: tags.keyword, class: "cmt-keyword"},
  {tag: tags.atom, class: "cmt-atom"},
  {tag: tags.bool, class: "cmt-bool"},
  {tag: tags.url, class: "cmt-url"},
  {tag: tags.labelName, class: "cmt-labelName"},
  {tag: tags.inserted, class: "cmt-inserted"},
  {tag: tags.deleted, class: "cmt-deleted"},
  {tag: tags.literal, class: "cmt-literal"},
  {tag: tags.string, class: "cmt-string"},
  {tag: tags.number, class: "cmt-number"},
  {tag: [tags.regexp, tags.escape, tags.special(tags.string)], class: "cmt-string2"},
  {tag: tags.variableName, class: "cmt-variableName"},
  {tag: tags.local(tags.variableName), class: "cmt-variableName cmt-local"},
  {tag: tags.definition(tags.variableName), class: "cmt-variableName cmt-definition"},
  {tag: tags.special(tags.variableName), class: "cmt-variableName2"},
  {tag: tags.definition(tags.propertyName), class: "cmt-propertyName cmt-definition"},
  {tag: tags.typeName, class: "cmt-typeName"},
  {tag: tags.namespace, class: "cmt-namespace"},
  {tag: tags.className, class: "cmt-className"},
  {tag: tags.macroName, class: "cmt-macroName"},
  {tag: tags.propertyName, class: "cmt-propertyName"},
  {tag: tags.operator, class: "cmt-operator"},
  {tag: tags.comment, class: "cmt-comment"},
  {tag: tags.meta, class: "cmt-meta"},
  {tag: tags.invalid, class: "cmt-invalid"},
  {tag: tags.punctuation, class: "cmt-punctuation"}
])
