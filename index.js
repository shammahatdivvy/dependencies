const { namedTypes } = require("ast-types");
const { parse } = require("@babel/parser");
const { visit } = require("recast");
const stringify = require("fast-safe-stringify");
const path = require("path");
const fs = require('fs');
const { walk } = require('walk');

const babelOptions = {
    sourceType: "module",
    strictMode: false,
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    startLine: 1,
    tokens: true,
    plugins: [
        "asyncGenerators",
        "bigInt",
        "classPrivateMethods",
        "classPrivateProperties",
        "classProperties",
        "decorators-legacy",
        "doExpressions",
        "dynamicImport",
        "exportDefaultFrom",
        "exportExtensions",
        "exportNamespaceFrom",
        "functionBind",
        "functionSent",
        "importMeta",
        "nullishCoalescingOperator",
        "numericSeparator",
        "objectRestSpread",
        "optionalCatchBinding",
        "optionalChaining",
        ["pipelineOperator", { proposal: "minimal" }],
        "throwExpressions",
        "jsx",
        "typescript"
    ]
};

const modules = {};

function countModule(moduleName) {
    const indexJsFile = moduleName + '/index.js'
    const jsFile = moduleName + '/index.js'
    if (fs.existsSync(indexJsFile)) {
        moduleName = indexJs
    } else if (fs.existsSync(jsFile)) {
        moduleName += '.js'
    }
    if (!(moduleName in modules)) {
        modules[moduleName] = 0;
    }
    modules[moduleName]++;
}

function normalizeModuleName(moduleName) {
    if (path.extname(moduleName) === '') {
        return path.join(moduleName, 'index.js')
    }
    return moduleName
}

function addModule(moduleName, sourcePath, rootPath) {
    const splitName = moduleName.split(path.sep);
    if (['.', '..'].includes(splitName[0])) {
        // Remove source file name
        splitName.pop();
        const modulePath = path.join(...splitName);
        countModule(path.join(sourcePath, normalizeModuleName(modulePath)));
    } else if (['@app', '@shared', '@client'].includes(splitName[0])) {
        // Remove special path specifier
        splitName.shift();
        const modulePath = path.join(...splitName);
        countModule(path.join(rootPath, normalizeModuleName(modulePath)))
    } else {
        countModule(moduleName);
    }
}

function processSource(source, sourcePath, rootPath) {
    const ast = parse(source, babelOptions);

    visit(ast, {
        // This method will be called for any node with .type "MemberExpression":
        // visitIdentifier(path) {
        //     console.log(path.value.name);
        //     return false;
        //     this.traverse(path);
        // },
        visitCallExpression(astPath) {
            const value = astPath.value;
            if (astPath.value.callee.name === 'require') {
                const moduleName = value.arguments[0].value;
                addModule(moduleName, sourcePath, rootPath)
            }
            this.traverse(astPath);
        },
        visitImportDeclaration(astPath) {
            const moduleName = astPath.value.source.value;
            addModule(moduleName, sourcePath, rootPath);
            this.traverse(astPath);
        }
    });
}

const walker = walk('../divvy-homes/src', { followLinks: false });

walker.on("file", (root, fileStats, next) => {
    if (!['.js', '.jsx', '.ts', '.tsx'].includes(path.extname(fileStats.name))) {
        return next();
    }
    if (fileStats.name.split(fs.sep).includes('_test')) {
        return next();
    }
    const fullPath = path.join(root, fileStats.name);
    fs.readFile(fullPath, function (err, data) {
        // console.log("Processing", fullPath);
        try {
            processSource(data.toString(), fullPath, '../divvy-homes/src');
        } catch (err) {
            console.log(err);
        }
        next();
    });
}).on('end', () => {
    console.log(stringify(modules));
})

