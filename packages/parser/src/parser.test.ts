import { describe, expect, it } from "vitest";
import { parse } from "./parser.js";
import type * as AST from "./ast.js";

function ok(code: string): AST.Program {
  const r = parse(code);
  expect(r.errors, r.errors.map((e) => `${e.loc.start.line}:${e.loc.start.column} ${e.message}`).join("\n")).toEqual([]);
  return r.ast;
}

function errors(code: string): string[] {
  return parse(code).errors.map((e) => e.message);
}

/** Compact s-expression rendering of an expression for precedence tests. */
function sx(node: AST.Node | null | undefined): string {
  if (!node) return "_";
  switch (node.type) {
    case "Identifier": return node.name;
    case "Literal": return node.raw;
    case "BinaryExpression":
    case "LogicalExpression": return `(${node.operator} ${sx(node.left)} ${sx(node.right)})`;
    case "UnaryExpression": return `(${node.operator} ${sx(node.argument)})`;
    case "UpdateExpression": return node.prefix ? `(${node.operator}pre ${sx(node.argument)})` : `(${node.operator}post ${sx(node.argument)})`;
    case "ConditionalExpression": return `(? ${sx(node.test)} ${sx(node.consequent)} ${sx(node.alternate)})`;
    case "ParenthesizedExpression": return sx(node.expression);
    case "CallExpression": return `(call ${sx(node.callee)} ${node.arguments.map(sx).join(" ")})`;
    case "NewExpression": return `(new ${sx(node.callee)} ${node.arguments.map(sx).join(" ")})`;
    case "MemberExpression": return `(. ${sx(node.object)} ${node.property.name})`;
    case "IndexExpression": return `([${node.accessor} ${sx(node.object)} ${node.indices.map(sx).join(" ")})`;
    case "AssignmentExpression": return `(${node.operator} ${sx(node.left)} ${sx(node.right)})`;
    case "ArrayExpression": return `[${node.elements.map(sx).join(" ")}]`;
    case "StructExpression": return `{${node.properties.map((p) => `${sx(p.key)}:${sx(p.value)}`).join(" ")}}`;
    case "TemplateLiteral": return `(tpl ${node.expressions.map(sx).join(" ")})`;
    case "FunctionExpression": return `(fn ${node.params.map((p) => p.id.name).join(" ")})`;
    default: return node.type;
  }
}

function expr(code: string): string {
  const program = ok(`x = ${code};`);
  const stmt = program.body[0] as AST.ExpressionStatement;
  return sx((stmt.expression as AST.AssignmentExpression).right);
}

function stmt(code: string): AST.Statement {
  return ok(code).body[0]!;
}

describe("expressions", () => {
  it("follows GameMaker precedence", () => {
    expect(expr("a + b * c")).toBe("(+ a (* b c))");
    expect(expr("a & b == c")).toBe("(== (& a b) c)"); // bitwise binds tighter than comparison
    expect(expr("a || b && c")).toBe("(|| a (&& b c))");
    expect(expr("a && b ^^ c")).toBe("(&& a (^^ b c))");
    expect(expr("a ?? b || c")).toBe("(?? a (|| b c))");
    expect(expr("a < b ? c : d")).toBe("(? (< a b) c d)");
    expect(expr("a << 1 + 2")).toBe("(<< a (+ 1 2))");
    expect(expr("a - b - c")).toBe("(- (- a b) c)");
    expect(expr("a div b mod c")).toBe("(mod (div a b) c)");
    expect(expr("not a and b")).toBe("(and (not a) b)");
    expect(expr("-a.b[0]")).toBe("(- ([ (. a b) 0))");
  });

  it("treats = as comparison inside expressions", () => {
    expect(expr("a = b")).toBe("(= a b)");
    const s = stmt("if (a = 1) b = 2;") as AST.IfStatement;
    expect(sx(s.test)).toBe("(= a 1)");
  });

  it("parses accessors", () => {
    expect(expr("l[| 0]")).toBe("([| l 0)");
    expect(expr("m[? \"k\"]")).toBe("([? m \"k\")");
    expect(expr("g[# 1, 2]")).toBe("([# g 1 2)");
    expect(expr("a[@ 3]")).toBe("([@ a 3)");
    expect(expr("s[$ key]")).toBe("([$ s key)");
    expect(expr("s[$\"key\"]")).toBe("([$ s \"key\")");
    expect(expr("a[1, 2]")).toBe("([ a 1 2)");
    expect(expr("[$FF, #FF0000]")).toBe("[$FF #FF0000]");
  });

  it("parses calls, omitted arguments, new, members", () => {
    expect(expr("f(a, , c)")).toBe("(call f a _ c)");
    expect(expr("f(a,)")).toBe("(call f a)");
    expect(expr("new Vec(1, 2).x")).toBe("(. (new Vec 1 2) x)");
    expect(expr("other.hp")).toBe("(. other hp)");
    expect(expr("f()()")).toBe("(call (call f ) )");
  });

  it("parses literals", () => {
    expect(expr("0x1F")).toBe("0x1F");
    expect(expr("$1F")).toBe("$1F");
    expect(expr("0b101")).toBe("0b101");
    expect(expr(".5")).toBe(".5");
    expect(expr("1_000")).toBe("1_000");
    expect(expr("#AEF033")).toBe("#AEF033");
    expect(expr("@\"C:\\path\"")).toBe("@\"C:\\path\"");
    expect(expr("true")).toBe("true");
    expect(expr("undefined")).toBe("undefined");
    const lit = (ok(`x = "a\\nb";`).body[0] as AST.ExpressionStatement).expression as AST.AssignmentExpression;
    expect((lit.right as AST.Literal).value).toBe("a\nb");
  });

  it("parses template strings with nested expressions", () => {
    expect(expr('$"hp: {hp} / {max(1, f("}"))}"')).toBe('(tpl hp (call max 1 (call f "}")))');
  });

  it("parses structs, arrays and function expressions", () => {
    expect(expr("{ a: 1, b, \"c\": 2, }")).toBe("{a:1 b:_ \"c\":2}");
    expect(expr("[1, 2, ]")).toBe("[1 2]");
    expect(expr("function(a, b = 2) { return a; }")).toBe("(fn a b)");
  });

  it("parses postfix and prefix updates", () => {
    expect(sx((stmt("i++;") as AST.ExpressionStatement).expression)).toBe("(++post i)");
    expect(sx((stmt("--i;") as AST.ExpressionStatement).expression)).toBe("(--pre i)");
  });
});

describe("statements", () => {
  it("parses assignment operators", () => {
    for (const op of ["=", ":=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "??="]) {
      const s = stmt(`a ${op} 1;`) as AST.ExpressionStatement;
      expect(s.expression.type).toBe("AssignmentExpression");
      expect((s.expression as AST.AssignmentExpression).operator).toBe(op);
    }
  });

  it("parses declarations", () => {
    const v = stmt("var a = 1, b, c = 2;") as AST.VariableDeclaration;
    expect(v.declarations.map((d) => d.id.name)).toEqual(["a", "b", "c"]);
    expect(v.semicolon).toBe(true);
    expect((stmt("var a = 1") as AST.VariableDeclaration).semicolon).toBe(false);
    expect((stmt("static count = 0;") as AST.VariableDeclaration).kind).toBe("static");
    expect((stmt("globalvar g;") as AST.VariableDeclaration).kind).toBe("globalvar");
  });

  it("parses control flow", () => {
    expect(stmt("if a then b = 1 else b = 2").type).toBe("IfStatement");
    expect((stmt("if (a) { } else if (b) { } else { }") as AST.IfStatement).alternate?.type).toBe("IfStatement");
    expect(stmt("while (a) a--;").type).toBe("WhileStatement");
    expect(stmt("do { a++; } until (a > 10);").type).toBe("DoUntilStatement");
    expect(stmt("repeat (3) f();").type).toBe("RepeatStatement");
    expect(stmt("with (obj_player) hp = 0;").type).toBe("WithStatement");
    const f = stmt("for (var i = 0; i < 10; i++) { }") as AST.ForStatement;
    expect(f.init?.type).toBe("VariableDeclaration");
    expect(sx(f.update?.expression)).toBe("(++post i)");
    const g = stmt("for (i = 0; i < 10; i += 1;) { }") as AST.ForStatement;
    expect(sx(g.update?.expression)).toBe("(+= i 1)");
  });

  it("parses begin/end blocks", () => {
    const b = stmt("begin a = 1; end") as AST.BlockStatement;
    expect(b.style).toBe("begin-end");
    expect(b.body).toHaveLength(1);
  });

  it("parses switch", () => {
    const s = stmt("switch (x) { case 1: case 2: f(); break; default: g(); }") as AST.SwitchStatement;
    expect(s.cases.map((c) => (c.test ? sx(c.test) : "default"))).toEqual(["1", "2", "default"]);
    expect(s.cases[1]!.consequent).toHaveLength(2);
  });

  it("parses try/catch/finally and throw", () => {
    const t = stmt("try { f(); } catch (e) { show_debug_message(e); } finally { g(); }") as AST.TryStatement;
    expect(t.handler?.param?.name).toBe("e");
    expect(t.finalizer).not.toBeNull();
    expect(stmt('throw "x";').type).toBe("ThrowStatement");
  });

  it("parses functions and constructors", () => {
    const f = stmt("function Vec2(_x, _y = 0) : Vec(_x) constructor { x = _x; }") as AST.FunctionDeclaration;
    expect(f.id.name).toBe("Vec2");
    expect(f.isConstructor).toBe(true);
    expect(f.parent?.callee.name).toBe("Vec");
    expect(f.params[1]!.init).not.toBeNull();
  });

  it("parses enums", () => {
    const e = stmt("enum Fruit { Apple, Banana = 5, Cherry }") as AST.EnumDeclaration;
    expect(e.members.map((m) => m.id.name)).toEqual(["Apple", "Banana", "Cherry"]);
  });

  it("parses exit, return, delete, empty statements", () => {
    const p = ok("exit; return; return 1; delete s;;");
    expect(p.body.map((s) => s.type)).toEqual([
      "ExitStatement", "ReturnStatement", "ReturnStatement", "DeleteStatement", "EmptyStatement",
    ]);
  });

  it("allows statements without semicolons", () => {
    expect(ok("a = 1\nb = 2\nf()").body).toHaveLength(3);
    expect(ok("a = 1 b = 2").body).toHaveLength(2);
  });
});

describe("directives", () => {
  it("parses macros with config and continuations", () => {
    const p = ok("#macro SPEED 4\n#macro Release:DEBUG false\n#macro LONG if (a) {\\\n  b();\\\n}\nx = SPEED;");
    const [a, b, c] = p.body as AST.MacroDeclaration[];
    expect(a!.id.name).toBe("SPEED");
    expect(a!.expression?.type).toBe("Literal");
    expect(b!.config?.name).toBe("Release");
    expect(b!.id.name).toBe("DEBUG");
    expect(c!.value).toBe("if (a) {\n  b();\n}");
    expect(c!.expression).toBeNull();
    expect(p.body[3]!.type).toBe("ExpressionStatement");
  });

  it("parses regions, including inside blocks", () => {
    const p = ok("#region Setup\na = 1;\nif (a) {\n#region inner\nb = 1;\n#endregion\n}\n#endregion");
    expect(p.body.map((s) => s.type)).toEqual(["RegionDirective", "ExpressionStatement", "IfStatement", "RegionDirective"]);
    const block = (p.body[2] as AST.IfStatement).consequent as AST.BlockStatement;
    expect(block.body.map((s) => s.type)).toEqual(["RegionDirective", "ExpressionStatement", "RegionDirective"]);
  });

  it("collects comments", () => {
    const p = ok("/// @desc hi\n// line\n/* block */ a = 1;");
    expect(p.comments.map((c) => [c.type, c.value])).toEqual([
      ["Line", "/ @desc hi"],
      ["Line", " line"],
      ["Block", " block "],
    ]);
  });
});

describe("errors", () => {
  it("reports and recovers from syntax errors", () => {
    const r = parse("a = ;\nb = 2;\nif (c { d = 1; }\ne = 3;");
    expect(r.errors.length).toBeGreaterThan(0);
    const names = r.ast.body.map((s) => s.type);
    expect(names).toContain("IfStatement");
    expect(names.filter((n) => n === "ExpressionStatement").length).toBeGreaterThanOrEqual(2);
  });

  it("reports unclosed blocks and strings", () => {
    expect(errors("if (a) {\n b = 1;")).toEqual(["Expected '}' to close the block opened here"]);
    expect(errors('a = "abc\nb = 1;')[0]).toBe("Unterminated string literal");
  });

  it("reports stray tokens", () => {
    expect(errors("a = 1 )").length).toBe(1);
    expect(errors("}").length).toBe(1);
    expect(errors("else a = 1;").length).toBe(1);
  });

  it("never throws on garbage", () => {
    for (const code of ["((((", "[[[", "{{{", "a.", "f(", "$\"{", "#macro", "function", "enum {", "switch", "case:", "@\"", "\\", "`", "a[|", "new", "var", "for(;;"]) {
      expect(() => parse(code)).not.toThrow();
    }
  });

  it("produces accurate locations", () => {
    const p = ok("a = 1;\n  foo(bar);");
    const call = (p.body[1] as AST.ExpressionStatement).expression as AST.CallExpression;
    expect(call.loc).toEqual({ start: { line: 2, column: 2 }, end: { line: 2, column: 10 } });
    expect(call.range).toEqual([9, 17]);
  });
});
