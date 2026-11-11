/**
 * GML abstract syntax tree.
 *
 * Shaped after ESTree so ESLint (and anyone who knows ESLint) feels at home:
 * every node has a `type`, a half-open `range` of UTF-16 offsets, and a `loc`
 * with 1-based lines and 0-based columns.
 *
 * GML-specific constructs get their own node types instead of being squeezed
 * into ESTree ones (accessors, `repeat`, `with`, `exit`, `#macro`, ...).
 */

export interface Position {
  /** 1-based line */
  line: number;
  /** 0-based column (UTF-16 code units) */
  column: number;
}

export interface SourceLocation {
  start: Position;
  end: Position;
}

export type Range = [start: number, end: number];

export interface BaseNode {
  type: string;
  range: Range;
  loc: SourceLocation;
  /**
   * Marks a node produced by expanding a `#macro`; its range is the macro
   * reference, not real text. The parser itself never sets this.
   */
  fromMacro?: string;
}

// ---------------------------------------------------------------------------
// Program and directives
// ---------------------------------------------------------------------------

export interface Program extends BaseNode {
  type: "Program";
  /**
   * Statements. `#macro`, `#region`, `#endregion` and `#define` directives are
   * included here at the statement-list position they appear in.
   */
  body: Statement[];
  /** Comments, in source order. Not part of the tree; not visited. */
  comments: Comment[];
  /** Tokens, in source order (comments excluded). Not visited. */
  tokens: Token[];
}

export interface Comment {
  /** `Line` for `//` (and `///` doc comments), `Block` for `/* *\/`. */
  type: "Line" | "Block";
  /** Text without the comment markers. A `///` comment's value starts with `/`. */
  value: string;
  range: Range;
  loc: SourceLocation;
}

export type TokenType =
  | "Identifier"
  | "Keyword"
  | "Punctuator"
  | "Numeric"
  | "String"
  | "Template"
  | "Directive";

export interface Token {
  type: TokenType;
  value: string;
  range: Range;
  loc: SourceLocation;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type Statement =
  | BlockStatement
  | EmptyStatement
  | ExpressionStatement
  | VariableDeclaration
  | IfStatement
  | WhileStatement
  | DoUntilStatement
  | RepeatStatement
  | ForStatement
  | WithStatement
  | SwitchStatement
  | BreakStatement
  | ContinueStatement
  | ExitStatement
  | ReturnStatement
  | ThrowStatement
  | TryStatement
  | DeleteStatement
  | EnumDeclaration
  | FunctionDeclaration
  | MacroDeclaration
  | RegionDirective
  | DefineDirective
  | InvalidStatement;

export interface BlockStatement extends BaseNode {
  type: "BlockStatement";
  body: Statement[];
  /** `{ }` or GML's `begin ... end`. */
  style: "braces" | "begin-end";
}

/** A lone `;`. GML allows them almost anywhere; GM1033 cares about them. */
export interface EmptyStatement extends BaseNode {
  type: "EmptyStatement";
}

export interface ExpressionStatement extends BaseNode {
  type: "ExpressionStatement";
  expression: Expression | AssignmentExpression;
  /** Whether the statement was terminated with `;`. */
  semicolon: boolean;
}

export interface VariableDeclaration extends BaseNode {
  type: "VariableDeclaration";
  kind: "var" | "static" | "globalvar";
  declarations: VariableDeclarator[];
  semicolon: boolean;
}

export interface VariableDeclarator extends BaseNode {
  type: "VariableDeclarator";
  id: Identifier;
  init: Expression | null;
}

export interface IfStatement extends BaseNode {
  type: "IfStatement";
  test: Expression;
  consequent: Statement;
  alternate: Statement | null;
  /** `if x then y` */
  then: boolean;
}

export interface WhileStatement extends BaseNode {
  type: "WhileStatement";
  test: Expression;
  body: Statement;
}

export interface DoUntilStatement extends BaseNode {
  type: "DoUntilStatement";
  body: Statement;
  test: Expression;
}

export interface RepeatStatement extends BaseNode {
  type: "RepeatStatement";
  count: Expression;
  body: Statement;
}

export interface ForStatement extends BaseNode {
  type: "ForStatement";
  init: VariableDeclaration | ExpressionStatement | null;
  test: Expression | null;
  update: ExpressionStatement | null;
  body: Statement;
}

export interface WithStatement extends BaseNode {
  type: "WithStatement";
  object: Expression;
  body: Statement;
}

export interface SwitchStatement extends BaseNode {
  type: "SwitchStatement";
  discriminant: Expression;
  cases: SwitchCase[];
}

export interface SwitchCase extends BaseNode {
  type: "SwitchCase";
  /** `null` for `default:` */
  test: Expression | null;
  consequent: Statement[];
}

export interface BreakStatement extends BaseNode {
  type: "BreakStatement";
}

export interface ContinueStatement extends BaseNode {
  type: "ContinueStatement";
}

export interface ExitStatement extends BaseNode {
  type: "ExitStatement";
}

export interface ReturnStatement extends BaseNode {
  type: "ReturnStatement";
  argument: Expression | null;
}

export interface ThrowStatement extends BaseNode {
  type: "ThrowStatement";
  argument: Expression;
}

export interface TryStatement extends BaseNode {
  type: "TryStatement";
  block: BlockStatement;
  handler: CatchClause | null;
  finalizer: BlockStatement | null;
}

export interface CatchClause extends BaseNode {
  type: "CatchClause";
  param: Identifier | null;
  body: BlockStatement;
}

export interface DeleteStatement extends BaseNode {
  type: "DeleteStatement";
  argument: Expression;
}

export interface EnumDeclaration extends BaseNode {
  type: "EnumDeclaration";
  id: Identifier;
  members: EnumMember[];
}

export interface EnumMember extends BaseNode {
  type: "EnumMember";
  id: Identifier;
  initializer: Expression | null;
}

export interface FunctionDeclaration extends BaseNode {
  type: "FunctionDeclaration";
  id: Identifier;
  params: Parameter[];
  body: BlockStatement;
  isConstructor: boolean;
  /** `function B() : A(1) constructor` */
  parent: ConstructorParent | null;
}

export interface FunctionExpression extends BaseNode {
  type: "FunctionExpression";
  id: Identifier | null;
  params: Parameter[];
  body: BlockStatement;
  isConstructor: boolean;
  parent: ConstructorParent | null;
}

export interface Parameter extends BaseNode {
  type: "Parameter";
  id: Identifier;
  /** Default value, for optional parameters. */
  init: Expression | null;
}

export interface ConstructorParent extends BaseNode {
  type: "ConstructorParent";
  callee: Identifier;
  arguments: Array<Expression | null>;
}

/** `#macro [Config:]NAME value` */
export interface MacroDeclaration extends BaseNode {
  type: "MacroDeclaration";
  id: Identifier;
  /** Configuration name for `#macro Config:NAME value`. */
  config: Identifier | null;
  /** The raw macro body, with `\` line continuations removed. */
  value: string;
  /** Range of the body in the source. */
  valueRange: Range;
  /**
   * The body parsed as an expression, when it is one. Not visited by default
   * (it is not real code at this position); see `visitorKeys`.
   */
  expression: Expression | null;
}

/** `#region name` / `#endregion` */
export interface RegionDirective extends BaseNode {
  type: "RegionDirective";
  kind: "region" | "endregion";
  name: string;
}

/** Legacy `#define name` (GameMaker 1.x script separators). */
export interface DefineDirective extends BaseNode {
  type: "DefineDirective";
  name: string;
}

/** Tokens the parser could not make sense of; always accompanied by a ParseError. */
export interface InvalidStatement extends BaseNode {
  type: "InvalidStatement";
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type Expression =
  | Identifier
  | Literal
  | TemplateLiteral
  | ArrayExpression
  | StructExpression
  | FunctionExpression
  | ParenthesizedExpression
  | UnaryExpression
  | UpdateExpression
  | BinaryExpression
  | LogicalExpression
  | ConditionalExpression
  | CallExpression
  | NewExpression
  | MemberExpression
  | IndexExpression
  | InvalidExpression;

export interface Identifier extends BaseNode {
  type: "Identifier";
  name: string;
}

export type LiteralKind =
  | "real"
  | "hex"
  | "binary"
  | "colour"
  | "string"
  | "verbatim"
  | "boolean"
  | "undefined";

export interface Literal extends BaseNode {
  type: "Literal";
  kind: LiteralKind;
  value: number | string | boolean | null;
  raw: string;
}

export interface TemplateLiteral extends BaseNode {
  type: "TemplateLiteral";
  /** Text chunks; always `expressions.length + 1` of them. */
  quasis: TemplateElement[];
  expressions: Expression[];
}

export interface TemplateElement extends BaseNode {
  type: "TemplateElement";
  /** Raw text (escapes not processed). */
  value: string;
}

export interface ArrayExpression extends BaseNode {
  type: "ArrayExpression";
  elements: Expression[];
}

export interface StructExpression extends BaseNode {
  type: "StructExpression";
  properties: StructProperty[];
}

export interface StructProperty extends BaseNode {
  type: "StructProperty";
  /** Identifier, or string literal key (`{ "a": 1 }`). */
  key: Identifier | Literal;
  /** `null` for shorthand `{ a }`. */
  value: Expression | null;
}

export interface ParenthesizedExpression extends BaseNode {
  type: "ParenthesizedExpression";
  expression: Expression;
}

export type UnaryOperator = "!" | "not" | "-" | "+" | "~";

export interface UnaryExpression extends BaseNode {
  type: "UnaryExpression";
  operator: UnaryOperator;
  argument: Expression;
}

export interface UpdateExpression extends BaseNode {
  type: "UpdateExpression";
  operator: "++" | "--";
  prefix: boolean;
  argument: Expression;
}

export type BinaryOperator =
  | "*" | "/" | "%" | "mod" | "div"
  | "+" | "-"
  | "<<" | ">>"
  | "&" | "|" | "^"
  | "==" | "=" | "!=" | "<>" | "<" | "<=" | ">" | ">=";

export interface BinaryExpression extends BaseNode {
  type: "BinaryExpression";
  /** `=` here is GML's comparison-in-expression-position. */
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
}

export type LogicalOperator = "&&" | "and" | "||" | "or" | "^^" | "xor" | "??";

export interface LogicalExpression extends BaseNode {
  type: "LogicalExpression";
  operator: LogicalOperator;
  left: Expression;
  right: Expression;
}

export interface ConditionalExpression extends BaseNode {
  type: "ConditionalExpression";
  test: Expression;
  consequent: Expression;
  alternate: Expression;
}

export interface CallExpression extends BaseNode {
  type: "CallExpression";
  callee: Expression;
  /** `null` marks an omitted argument: `f(a, , c)`. */
  arguments: Array<Expression | null>;
}

export interface NewExpression extends BaseNode {
  type: "NewExpression";
  callee: Expression;
  arguments: Array<Expression | null>;
}

export interface MemberExpression extends BaseNode {
  type: "MemberExpression";
  object: Expression;
  property: Identifier;
}

/**
 * `a[i]`, `a[i, j]`, and the accessors `a[| i]` (list), `a[? k]` (map),
 * `a[# x, y]` (grid), `a[@ i]` (array by reference), `a[$ k]` (struct).
 */
export type Accessor = "" | "|" | "?" | "#" | "@" | "$";

export interface IndexExpression extends BaseNode {
  type: "IndexExpression";
  object: Expression;
  accessor: Accessor;
  indices: Expression[];
}

/** Placeholder where an expression was required but could not be parsed. */
export interface InvalidExpression extends BaseNode {
  type: "InvalidExpression";
}

export type AssignmentOperator =
  | "=" | ":=" | "+=" | "-=" | "*=" | "/=" | "%=" | "&=" | "|=" | "^=" | "<<=" | ">>=" | "??=";

/**
 * Assignment. GML has no assignment *expressions*: these only appear as the
 * expression of an ExpressionStatement (including `for` init/update).
 */
export interface AssignmentExpression extends BaseNode {
  type: "AssignmentExpression";
  operator: AssignmentOperator;
  left: Expression;
  right: Expression;
}

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

export type Node =
  | Program
  | Statement
  | Expression
  | AssignmentExpression
  | VariableDeclarator
  | SwitchCase
  | CatchClause
  | EnumMember
  | Parameter
  | ConstructorParent
  | TemplateElement
  | StructProperty;

export type NodeType = Node["type"];

export type NodeOfType<T extends NodeType> = Extract<Node, { type: T }>;

export type FunctionLike = FunctionDeclaration | FunctionExpression;

export type LoopStatement =
  | WhileStatement
  | DoUntilStatement
  | RepeatStatement
  | ForStatement
  | WithStatement;
