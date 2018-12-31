/* jslint node: true */
'use strict';

//  ENiGMA½
const ansi          = require('./ansi_term.js');
const Events        = require('./events.js');
const { Errors }    = require('./enig_error.js');

//  deps
const async     = require('async');

exports.connectEntry    = connectEntry;

function ansiDiscoverHomePosition(client, cb) {
    //
    //  We want to find the home position. ANSI-BBS and most terminals
    //  utilize 1,1 as home. However, some terminals such as ConnectBot
    //  think of home as 0,0. If this is the case, we need to offset
    //  our positioning to accommodate for such.
    //
    const done = function(err) {
        client.removeListener('cursor position report', cprListener);
        clearTimeout(giveUpTimer);
        return cb(err);
    };

    const cprListener = function(pos) {
        const h = pos[0];
        const w = pos[1];

        //
        //  We expect either 0,0, or 1,1. Anything else will be filed as bad data
        //
        if(h > 1 || w > 1) {
            client.log.warn( { height : h, width : w }, 'Ignoring ANSI home position CPR due to unexpected values');
            return done(Errors.UnexpectedState('Home position CPR expected to be 0,0, or 1,1'));
        }

        if(0 === h & 0 === w) {
            //
            //  Store a CPR offset in the client. All CPR's from this point on will offset by this amount
            //
            client.log.info('Setting CPR offset to 1');
            client.cprOffset = 1;
        }

        return done(null);
    };

    client.once('cursor position report', cprListener);

    const giveUpTimer = setTimeout( () => {
        return done(Errors.General('Giving up on home position CPR'));
    }, 3000);   //  3s

    client.term.write(`${ansi.goHome()}${ansi.queryPos()}`);    //  go home, query pos
}

function ansiQueryTermSizeIfNeeded(client, cb) {
    if(client.term.termHeight > 0 || client.term.termWidth > 0) {
        return cb(null);
    }

    const done = function(err) {
        client.removeListener('cursor position report', cprListener);
        clearTimeout(giveUpTimer);
        return cb(err);
    };

    const cprListener = function(pos) {
        //
        //  If we've already found out, disregard
        //
        if(client.term.termHeight > 0 || client.term.termWidth > 0) {
            return done(null);
        }

        const h = pos[0];
        const w = pos[1];

        //
        //  NetRunner for example gives us 1x1 here. Not really useful. Ignore
        //  values that seem obviously bad. Included in the set is the explicit
        //  999x999 values we asked to move to.
        //
        if(h < 10 || h === 999 || w < 10 || w === 999) {
            client.log.warn(
                { height : h, width : w },
                'Ignoring ANSI CPR screen size query response due to non-sane values');
            return done(Errors.Invalid('Term size <= 10 considered invalid'));
        }

        client.term.termHeight  = h;
        client.term.termWidth   = w;

        client.log.debug(
            {
                termWidth   : client.term.termWidth,
                termHeight  : client.term.termHeight,
                source      : 'ANSI CPR'
            },
            'Window size updated'
        );

        return done(null);
    };

    client.once('cursor position report', cprListener);

    //  give up after 2s
    const giveUpTimer = setTimeout( () => {
        return done(Errors.General('No term size established by CPR within timeout'));
    }, 2000);

    //  Start the process:
    //  1 - Ask to goto 999,999 -- a very much "bottom right" (generally 80x25 for example
    //      is the real size)
    //  2 - Query for screen size with bansi.txt style specialized Device Status Report (DSR)
    //      request. We expect a CPR of:
    //      a - Terms that support bansi.txt style: Screen size
    //      b - Terms that do not support bansi.txt style: Since we moved to the bottom right
    //          we should still be able to determine a screen size.
    //
    client.term.rawWrite(`${ansi.goto(999, 999)}${ansi.queryScreenSize()}`);
}

function prepareTerminal(term) {
    term.rawWrite(`${ansi.normal()}${ansi.clearScreen()}`);
}

function displayBanner(term) {
    //  note: intentional formatting:
    term.pipeWrite(`
|06Connected to |02EN|10i|02GMA|10½ |06BBS version |12|VN
|06Copyright (c) 2014-2018 Bryan Ashby |14- |12http://l33t.codes/
|06Updates & source |14- |12https://github.com/NuSkooler/enigma-bbs/
|00`
    );
}

function connectEntry(client, nextMenu) {
    const term = client.term;

    async.series(
        [
            function basicPrepWork(callback) {
                term.rawWrite(ansi.queryDeviceAttributes(0));
                return callback(null);
            },
            function discoverHomePosition(callback) {
                ansiDiscoverHomePosition(client, () => {
                    //  :TODO: If CPR for home fully fails, we should bail out on the connection with an error, e.g. ANSI support required
                    return callback(null);  //  we try to continue anyway
                });
            },
            function queryTermSizeByNonStandardAnsi(callback) {
                ansiQueryTermSizeIfNeeded(client, err => {
                    if(err) {
                        //
                        //  Check again; We may have got via NAWS/similar before CPR completed.
                        //
                        if(0 === term.termHeight || 0 === term.termWidth) {
                            //
                            //  We still don't have something good for term height/width.
                            //  Default to DOS size 80x25.
                            //
                            //  :TODO: Netrunner is currenting hitting this and it feels wrong. Why is NAWS/ENV/CPR all failing???
                            client.log.warn( { reason : err.message }, 'Failed to negotiate term size; Defaulting to 80x25!');

                            term.termHeight = 25;
                            term.termWidth  = 80;
                        }
                    }

                    return callback(null);
                });
            },
        ],
        () => {
            prepareTerminal(term);

            //
            //  Always show an ENiGMA½ banner
            //
            displayBanner(term);

            // fire event
            Events.emit(Events.getSystemEvents().TermDetected, { client : client } );

            setTimeout( () => {
                return client.menuStack.goto(nextMenu);
            }, 500);
        }
    );
}
