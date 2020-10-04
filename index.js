const { namedTypes } = require("ast-types");
const { parse } = require("@babel/parser");
const { visit } = require("recast");
const stringify = require("fast-safe-stringify");
const path = require("path");
const fs = require('fs');
const { walk } = require('walk');
const R = require('ramda');
const { assert } = require("console");

const babelOptions = {
    sourceType: "module",
    strictMode: false,
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    startLine: 1,
    tokens: true,
    errorRecovery: true,
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
        "typescript",
        "topLevelAwait"
    ]
};

const modules = {};

function countModule(moduleName, includingFile) {
    const potentialFiles = [
        moduleName + '.js',
        moduleName + '/index.js',
        moduleName + '/index.ts',
        moduleName + '.ts',
        moduleName + '.jsx',
        moduleName + '.tsx',
        path.join(moduleName, R.last(moduleName.split(path.sep)) + '.js'), // Weird search behavior
        path.join(moduleName, R.last(moduleName.split(path.sep)) + '.jsx'), // Weird search behavior
        moduleName,
    ];
    for (const fileName of potentialFiles) {
        if (!fs.existsSync(fileName)) {
            continue;
        }
        if (!(fileName in modules)) {
            modules[fileName] = {};
        }
        modules[fileName][includingFile] = true;
        return;
    }
    // Just include the module name directly.
    if (!(moduleName in modules)) {
        modules[moduleName] = {};
    }
    modules[moduleName][includingFile] = true;
}

const specialPaths = {
    '@app': './',
    '@client': './client',
    '@shared': './',
};

function addModule(moduleName, sourcePath, rootPath) {
    const splitName = moduleName.split(path.sep);
    if (['.', '..'].includes(splitName[0])) {
        const basePath = sourcePath.split(path.sep);
        basePath.pop();
        countModule(path.join(...basePath, moduleName), sourcePath);
    } else if (specialPaths[splitName[0]]) {
        // Remove special path specifier
        const prefixPath = specialPaths[splitName[0]];
        splitName.shift();
        const modulePath = path.join(prefixPath, ...splitName);
        countModule(path.join(rootPath, modulePath), sourcePath);
    } else {
        countModule(moduleName, sourcePath);
    }
}

const usedIdentifiers = {};
const declaredIdentifiers = {};


function addUsedIdentifier(identifier) {
    // Just include the module name directly.
    if (!(identifier in usedIdentifiers)) {
        usedIdentifiers[identifier] = 0;
    }
    usedIdentifiers[identifier] += 1;
}

function addDeclaration(identifier, sourcePath) {
    // Just include the module name directly.
    if (!(identifier in declaredIdentifiers)) {
        declaredIdentifiers[identifier] = [];
    }
    declaredIdentifiers[identifier].push(sourcePath);
}

function createCallExpressionVisitor(sourcePath, rootPath) {
    return function (astPath) {
        const value = astPath.value;

        // Handle tracking require'd files
        if (value.callee.name === 'require') {
            const moduleName = value.arguments[0].value;
            if (!moduleName) {
                return this.traverse(astPath);
            }
            addModule(moduleName, sourcePath, rootPath);
            return this.traverse(astPath);
        }

        // Handle tracking imported files
        if (value.callee.type === 'Import') {
            const moduleName = value.arguments[0].value;
            if (!moduleName) {
                return this.traverse(astPath);
            }
            addModule(moduleName, sourcePath, rootPath);
            return this.traverse(astPath);
        }

        // Handle tracking other function calls.
        const functionName = value.callee.name;
        if (functionName) {
            addUsedIdentifier(functionName);
        }
        this.traverse(astPath, {
            visitMemberExpression(astPath) {
                const objectName = astPath.value.object.name;
                if (objectName) {
                    addUsedIdentifier(objectName)
                }
                return false;
            },
            visitIdentifier(astPath) {
                const value = astPath.value;
                addUsedIdentifier(value.name)
                return false;
            },
            visitCallExpression: createCallExpressionVisitor(sourcePath, rootPath),
        })
    };
}

function processSource(source, sourcePath, rootPath) {
    const ast = parse(source, babelOptions);
    const visitCallExpression = createCallExpressionVisitor(sourcePath, rootPath);
    visit(ast, {
        visitFunctionDeclaration(astPath) {
            const value = astPath.value;
            // Some function declarations are anonymous.
            if (value.id) {
                const name = value.id.name;
                addDeclaration(name, sourcePath);
            }
            // We only want to visit call expressions 
            this.traverse(astPath, {
                visitCallExpression, visitIdentifier(astPath) {
                    const value = astPath.value;
                    addUsedIdentifier(value.name)
                    return false;
                },
            });
        },
        visitVariableDeclarator(astPath) {
            const value = astPath.value;
            const name = value.id.name;
            // Filter out require definitions
            if (name && value.init && !(value.init.type === 'CallExpression' && value.init.callee.name === 'require')) {
                // some declarations are via object unpacking
                // we don't really care much about these. 
                addDeclaration(name, sourcePath);
            }
            this.traverse(astPath, {
                visitCallExpression, visitIdentifier(astPath) {
                    const value = astPath.value;
                    addUsedIdentifier(value.name)
                    return false;
                },
            });
        },
        visitImportDeclaration(astPath) {
            const moduleName = astPath.value.source.value;
            addModule(moduleName, sourcePath, rootPath);
            return false;
        },
        visitCallExpression
    });
}
const walkOptions = {
    followLinks: false,
    filters: [
        "_test",
        "node_modules",
        "test",
        "stories",
        "build",
        ".storybook",
        "eslint-plugin-divvy-rules",
        "cypress",
        "coverage",
        "jest",
        "public",
    ]
}

const indexingWalker = walk('../divvy-homes', walkOptions);
indexingWalker.on("file", (root, fileStats, next) => {
    if (!['.js', '.jsx', '.ts', '.tsx'].includes(path.extname(fileStats.name))) {
        return next();
    }
    modules[path.join(root, fileStats.name)] = {};
    next();
}).on('end', () => {
    const walker = walk('../divvy-homes', walkOptions);
    walker.on("file", (root, fileStats, next) => {
        if (!['.js', '.jsx', '.ts', '.tsx'].includes(path.extname(fileStats.name))) {
            return next();
        }
        const fullPath = path.join(root, fileStats.name);
        fs.readFile(fullPath, function (err, data) {
            // console.log("Processing", fullPath);
            try {
                processSource(data.toString(), fullPath, '../divvy-homes/src');
            } catch (err) {
                console.log("error processing sourcefile:", fullPath)
                console.log(err);
            }
            next();
        });
    }).on('end', () => {
        for (const [key, value] of Object.entries(modules)) {
            console.log(`${key}, ${Object.entries(value).length}`)
        }
        // for (const [key, value] of Object.entries(declaredIdentifiers)) {
        //     console.log(`${key}, ${usedIdentifiers[key]}, ${value}`)
        // }
    })
})

