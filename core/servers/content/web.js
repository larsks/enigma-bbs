//  ENiGMA½
const Log = require('../../logger.js').log;
const ServerModule = require('../../server_module.js').ServerModule;
const Config = require('../../config.js').get;
const { Errors } = require('../../enig_error.js');
const { loadModulesForCategory, moduleCategories } = require('../../module_util');
const WebHandlerModule = require('../../web_handler_module');

//  deps
const http = require('http');
const https = require('https');
const _ = require('lodash');
const fs = require('graceful-fs');
const paths = require('path');
const mimeTypes = require('mime-types');
const forEachSeries = require('async/forEachSeries');
const findSeries = require('async/findSeries');

const ModuleInfo = (exports.moduleInfo = {
    name: 'Web',
    desc: 'Web Server',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.web.server',
});

exports.WellKnownLocations = {
    Rfc5785: '/.well-known', //  https://www.rfc-editor.org/rfc/rfc5785
    Internal: '/_enig', //  location of most enigma provided routes
};

class Route {
    constructor(route) {
        Object.assign(this, route);

        if (this.method) {
            this.method = this.method.toUpperCase();
        }

        try {
            this.pathRegExp = new RegExp(this.path);
        } catch (e) {
            this.log.error({ route: route }, 'Invalid regular expression for route path');
        }
    }

    isValid() {
        return (
            (this.pathRegExp instanceof RegExp &&
                -1 !==
                    [
                        'GET',
                        'HEAD',
                        'POST',
                        'PUT',
                        'DELETE',
                        'CONNECT',
                        'OPTIONS',
                        'TRACE',
                    ].indexOf(this.method)) ||
            !_.isFunction(this.handler)
        );
    }

    matchesRequest(req) {
        return req.method === this.method && this.pathRegExp.test(req.url);
    }

    getRouteKey() {
        return `${this.method}:${this.path}`;
    }
}

exports.getModule = class WebServerModule extends ServerModule {
    constructor() {
        super();

        this.log = Log.child({ server: 'Web' });

        const config = Config();
        this.enableHttp = config.contentServers.web.http.enabled || false;
        this.enableHttps = config.contentServers.web.https.enabled || false;

        this.routes = {};
    }

    logger() {
        return this.log;
    }

    getDomain() {
        const config = Config();
        const overridePrefix = _.get(config.contentServers.web.overrideUrlPrefix);
        if (_.isString(overridePrefix)) {
            const url = new URL(overridePrefix);
            return url.hostname;
        }

        return config.contentServers.web.domain;
    }

    buildUrl(pathAndQuery) {
        //
        //  Create a URL such as
        //  https://l33t.codes:44512/ + |pathAndQuery|
        //
        //  Prefer HTTPS over HTTP. Be explicit about the port
        //  only if non-standard. Allow users to override full prefix in config.
        //
        const config = Config();
        if (_.isString(config.contentServers.web.overrideUrlPrefix)) {
            return `${config.contentServers.web.overrideUrlPrefix}${pathAndQuery}`;
        }

        let schema;
        let port;
        if (config.contentServers.web.https.enabled) {
            schema = 'https://';
            port =
                443 === config.contentServers.web.https.port
                    ? ''
                    : `:${config.contentServers.web.https.port}`;
        } else {
            schema = 'http://';
            port =
                80 === config.contentServers.web.http.port
                    ? ''
                    : `:${config.contentServers.web.http.port}`;
        }

        return `${schema}${config.contentServers.web.domain}${port}${pathAndQuery}`;
    }

    isEnabled() {
        return this.enableHttp || this.enableHttps;
    }

    createServer(cb) {
        if (this.enableHttp) {
            this.httpServer = http.createServer((req, resp) =>
                this.routeRequest(req, resp)
            );
        }

        const config = Config();
        if (this.enableHttps) {
            const options = {
                cert: fs.readFileSync(config.contentServers.web.https.certPem),
                key: fs.readFileSync(config.contentServers.web.https.keyPem),
            };

            //  additional options
            Object.assign(options, config.contentServers.web.https.options || {});

            this.httpsServer = https.createServer(options, (req, resp) =>
                this.routeRequest(req, resp)
            );
        }

        return cb(null);
    }

    beforeListen(cb) {
        if (!this.isEnabled()) {
            return cb(null);
        }

        loadModulesForCategory(
            moduleCategories.WebHandlers,
            (module, nextModule) => {
                const moduleInst = new module.getModule();
                try {
                    const normalizedName = _.camelCase(module.moduleInfo.name);
                    if (!WebHandlerModule.isEnabled(normalizedName)) {
                        this.log.info(
                            { moduleName: normalizedName },
                            'Web handler module not enabled'
                        );
                        return nextModule(null);
                    }

                    Log.info(
                        { moduleName: normalizedName },
                        'Initializing web handler module'
                    );

                    moduleInst.init(this, err => {
                        return nextModule(err);
                    });
                } catch (e) {
                    this.log.error(
                        { error: e.message },
                        'Exception caught loading web handler'
                    );
                    return nextModule(e);
                }
            },
            err => {
                return cb(err);
            }
        );
    }

    listen(cb) {
        const config = Config();
        forEachSeries(
            ['http', 'https'],
            (service, nextService) => {
                const name = `${service}Server`;
                if (this[name]) {
                    const port = parseInt(config.contentServers.web[service].port);
                    if (isNaN(port)) {
                        this.log.error(
                            {
                                port: config.contentServers.web[service].port,
                                server: ModuleInfo.name,
                            },
                            `Invalid port (${service})`
                        );
                        return nextService(
                            Errors.Invalid(
                                `Invalid port: ${config.contentServers.web[service].port}`
                            )
                        );
                    }

                    this[name].listen(
                        port,
                        config.contentServers.web[service].address,
                        err => {
                            return nextService(err);
                        }
                    );
                } else {
                    return nextService(null);
                }
            },
            err => {
                return cb(err);
            }
        );
    }

    addRoute(route) {
        route = new Route(route);

        if (!route.isValid()) {
            this.log.error(
                { route: route },
                'Cannot add route: missing or invalid required members'
            );
            return false;
        }

        const routeKey = route.getRouteKey();
        if (routeKey in this.routes) {
            this.log.warn(
                { route: route, routeKey: routeKey },
                'Cannot add route: duplicate method/path combination exists'
            );
            return false;
        }

        this.routes[routeKey] = route;
        return true;
    }

    routeRequest(req, resp) {
        this.log.trace({ url: req.url, method: req.method }, 'Request');

        let route = _.find(this.routes, r => r.matchesRequest(req));

        if (route) {
            return route.handler(req, resp);
        } else {
            this.tryStaticRoute(req, resp, wasHandled => {
                if (!wasHandled) {
                    this.tryRouteIndex(req, resp, wasHandled => {
                        if (!wasHandled) {
                            return this.fileNotFound(resp);
                        }
                    });
                }
            });
        }
    }

    respondWithError(resp, code, bodyText, title) {
        const customErrorPage = paths.join(
            Config().contentServers.web.staticRoot,
            `${code}.html`
        );

        fs.readFile(customErrorPage, 'utf8', (err, data) => {
            resp.writeHead(code, { 'Content-Type': 'text/html' });

            if (err) {
                return resp.end(`<!doctype html>
                    <html lang="en">
                        <head>
                        <meta charset="utf-8">
                        <title>${title}</title>
                        <meta name="viewport" content="width=device-width, initial-scale=1">
                        </head>
                        <body>
                            <article>
                                <h2>${bodyText}</h2>
                            </article>
                        </body>
                    </html>`);
            }

            return resp.end(data);
        });
    }

    badRequest(resp) {
        return this.respondWithError(resp, 400, 'Bad request.', 'Bad Request');
    }

    accessDenied(resp) {
        return this.respondWithError(resp, 401, 'Access denied.', 'Access Denied');
    }

    fileNotFound(resp) {
        return this.respondWithError(resp, 404, 'File not found.', 'File Not Found');
    }

    resourceNotFound(resp) {
        return this.respondWithError(
            resp,
            404,
            'Resource not found.',
            'Resource Not Found'
        );
    }

    internalServerError(resp) {
        return this.respondWithError(
            resp,
            500,
            'Internal server error.',
            'Internal Server Error'
        );
    }

    tryRouteIndex(req, resp, cb) {
        const tryFiles = Config().contentServers.web.tryFiles || [
            'index.html',
            'index.htm',
        ];

        findSeries(
            tryFiles,
            (tryFile, nextTryFile) => {
                const fileName = paths.join(
                    req.url.substr(req.url.lastIndexOf('/', 1)),
                    tryFile
                );

                const filePath = this.resolveStaticPath(fileName);
                fs.stat(filePath, (err, stats) => {
                    if (err || !stats.isFile()) {
                        return nextTryFile(null, false);
                    }

                    const headers = {
                        'Content-Type':
                            mimeTypes.contentType(paths.basename(filePath)) ||
                            mimeTypes.contentType('.bin'),
                        'Content-Length': stats.size,
                    };

                    const readStream = fs.createReadStream(filePath);
                    resp.writeHead(200, headers);
                    readStream.pipe(resp);

                    return nextTryFile(null, true);
                });
            },
            (_, wasHandled) => {
                return cb(wasHandled);
            }
        );
    }

    tryStaticRoute(req, resp, cb) {
        const fileName = req.url.substr(req.url.lastIndexOf('/', 1));
        const filePath = this.resolveStaticPath(fileName);

        if (!filePath) {
            return cb(false);
        }

        fs.stat(filePath, (err, stats) => {
            if (err || !stats.isFile()) {
                return cb(false);
            }

            const headers = {
                'Content-Type':
                    mimeTypes.contentType(paths.basename(filePath)) ||
                    mimeTypes.contentType('.bin'),
                'Content-Length': stats.size,
            };

            const readStream = fs.createReadStream(filePath);
            resp.writeHead(200, headers);
            readStream.pipe(resp);

            return cb(true);
        });
    }

    resolveStaticPath(requestPath) {
        const staticRoot = _.get(Config(), 'contentServers.web.staticRoot');
        const path = paths.resolve(staticRoot, `.${requestPath}`);
        if (path.startsWith(staticRoot)) {
            return path;
        }
    }

    resolveTemplatePath(path) {
        if (paths.isAbsolute(path)) {
            return path;
        }

        const staticRoot = _.get(Config(), 'contentServers.web.staticRoot');
        const resolved = paths.resolve(staticRoot, path);
        if (resolved.startsWith(staticRoot)) {
            return resolved;
        }
    }

    routeTemplateFilePage(templatePath, preprocessCallback, resp) {
        const self = this;

        fs.readFile(templatePath, 'utf8', (err, templateData) => {
            if (err) {
                return self.fileNotFound(resp);
            }

            preprocessCallback(templateData, (err, finalPage, contentType) => {
                if (err || !finalPage) {
                    return self.respondWithError(
                        resp,
                        500,
                        'Internal Server Error.',
                        'Internal Server Error'
                    );
                }

                const headers = {
                    'Content-Type': contentType || mimeTypes.contentType('.html'),
                    'Content-Length': finalPage.length,
                };

                resp.writeHead(200, headers);
                return resp.end(finalPage);
            });
        });
    }
};
