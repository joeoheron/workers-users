/**
 * This class encapsulates the core functionality of a Cloudflare Worker designed to manage user sessions and authentication in a serverless environment. It leverages Cloudflare's D1 Database for storing user information and a custom session management service for session handling. The worker supports various endpoints for user management operations such as registration, login, logout, password reset, and fetching user session data.
 *
 * The worker uses a 'SHA-256' hashing algorithm for password security and implements basic CORS (Cross-Origin Resource Sharing) handling to support web client interactions. It defines an `Env` interface to type-check the environment variables, ensuring the worker has access to necessary external resources like the usersDB (D1 Database) and sessionService (an abstraction over Fetch API for session management).
 *
 * Key Functions:
 * - `fetch`: The main entry point for incoming requests, routing them to the appropriate handler based on the request path.
 * - `handleRegister`: Processes user registration requests, including user data validation, password hashing, and storing user information in the database.
 * - `handleLogin`: Authenticates users by comparing provided credentials against stored data, creating a session on successful authentication.
 * - `handleLogout`: Ends a user session and clears session data.
 * - `handleForgotPassword`: Initiates the password reset process (implementation placeholder).
 * - `handleLoadUser`: Retrieves session data for a logged-in user, demonstrating session management in action.
 * - `handleOptions`: Handles CORS preflight requests to ensure compatibility with web clients hosted on different origins.
 *
 * This worker is designed as a foundational component for building secure, stateful applications on the Cloudflare Workers platform, demonstrating how serverless architectures can support complex application features like user authentication and session management.
 */

// Hashing algorithm used for securing passwords. Using bcrypt is not practical in a Worker environment.
const hashingAlgo = 'SHA-256';

// Defines the environment variables required by the worker.
export interface Env {
	usersDB: D1Database; // Reference to Cloudflare's D1 Database for user data.
	sessionService: Fetcher; // Direct reference to session-state Worker for session management.
}

// CORS headers configuration to support cross-origin requests.
const corsHeaders: { [key: string]: string } = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
	"Access-Control-Max-Age": "86400",
	"Access-Control-Allow-Credentials": "true",
}

// Main worker class handling incoming requests and routing them to appropriate handlers.
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		let response: Response | null = null;
		// Handle CORS preflight requests.
		if (request.method === "OPTIONS") {
			response = handleOptions(request)
		} else {
			switch (path) {
				case '/register':
					response = await handleRegister(request, env);
					break
				case '/login':
					response = await handleLogin(request, env);
					break;
				case '/logout':
					response = await handleLogout(request, env);
					break;
				case '/forgot-password':
					response = await handleForgotPassword(request, env);
					break;
				case '/load-user':
					response = await handleLoadUser(request, env);
					break;
				default:
					response = new Response('Not Found', { status: 404 });
			}
		}
		// Append CORS headers to the response before returning.
		response.headers.set("Access-Control-Allow-Origin", getValidatedOrigin(request) || "*")
		response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		response.headers.set("Access-Control-Allow-Credentials", "true")
		return response;
	},
};

// Handles loading user data based on the session ID extracted from cookies.
// This is a demonstration of session management in action.
async function handleLoadUser(request: Request, env: Env): Promise<Response> {
	// Extract the cookie header
	const cookieHeader = request.headers.get('Cookie');

	// Parse the cookies to find the session ID
	let sessionId = null;
	if (cookieHeader) {
		const cookies = cookieHeader.split(';').map(cookie => cookie.trim());
		const sessionCookie = cookies.find(cookie => cookie.startsWith('cfw_session='));
		if (sessionCookie) {
			sessionId = sessionCookie.split('=')[1];
		}
	}

	if (sessionId) {
		// Call the session retrieval endpoint of the other worker
		const loadSessionUrl = `https://session-state.d1.compact.workers.dev/get/${sessionId}`;
		const loadRequest = new Request(loadSessionUrl);
		const loadResponse = await env.sessionService.fetch(loadRequest);
		const sessionData = await loadResponse.json();

		return new Response(JSON.stringify(sessionData), {
			headers: {
				'Access-Control-Allow-Origin': getValidatedOrigin(request) || '*',
				'Content-Type': 'application/json'
			}
		});
	}
	return new Response(JSON.stringify({ error: 'User not logged in' }), { status: 401 });
}

// Processes user registration requests, including validation, password hashing, and database insertion.
async function handleRegister(request: Request, env: Env): Promise<Response> {
	try {
		// Parse user data from the request body
		const regData = await request.json() as RegistrationData;
		const { username, password, firstName, lastName } = regData;

		// Basic validation
		if (!username || !password) {
			return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
		}

		// Check if the user already exists
		const checkUserQuery = 'SELECT Username FROM User WHERE Username = ?';
		const checkUserStmt = await env.usersDB.prepare(checkUserQuery);
		const existingUser = await checkUserStmt.bind(username).all();
		if (existingUser.success && existingUser.results.length > 0) {
			return new Response(JSON.stringify({ error: 'User already exists' }), { status: 409 });
		}

		const hashedPassword = await hashPassword(password);

		// Store user data in usersDB
		const insertUserQuery = 'INSERT INTO User (Username, Password, FirstName, LastName) VALUES (?, ?, ?, ?)';
		const insertUserStmt = await env.usersDB.prepare(insertUserQuery);
		await insertUserStmt.bind(username, hashedPassword, firstName, lastName).run();

		return new Response(JSON.stringify({ message: 'User registered successfully' }), { status: 201 });
	} catch (error) {
		// Handle any unexpected errors
		return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 });
	}
}

// Authenticates users by validating credentials and creating a session on successful login.
async function handleLogin(request: Request, env: Env): Promise<Response> {
	const credentials = await request.json() as Credentials;

	// Now credentials is typed as Credentials
	const { username, password } = credentials;
	try {
		if (username && password) {
			const query = 'SELECT * FROM User WHERE Username = ?1';
			const result = (await env.usersDB.prepare(query).bind(username).all()).results;
			if (result.length > 0) {

				const user = result[0];
				// Compare the provided password with the stored hash
				const passwordMatch = await comparePassword(password, user.Password as string);
				if (!passwordMatch) {
					return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 });
				}

				const sessionData = {
					username: user.Username,
					firstName: user.FirstName,
					lastName: user.LastName,
				};

				// Load any additional user data from the database or other sources to be stored in the session

				// Create a session
				const sessionCreationRequest = new Request("https://session-state.d1.compact.workers.dev/create", {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(sessionData),
				});
				const sessionResponse = await env.sessionService.fetch(sessionCreationRequest);
				const sessionId = await sessionResponse.text();
				// Set a cookie with the session ID
				const headers = new Headers({
					'Access-Control-Allow-Origin': getValidatedOrigin(request) || '*',
					'Content-Type': 'application/json',
					'Set-Cookie': `cfw_session=${sessionId}; Secure; Path=/; SameSite=None; Max-Age=${60 * 30}`

				});

				return new Response(JSON.stringify({ message: 'Login successful' }), { headers });
			}
		}
	} catch (error) {
		console.error("Unexpected error: " + error);
	}
	return new Response(JSON.stringify({ error: 'Login failed' }), { status: 401 });
}

// Ends a user's session and clears session-related data.
async function handleLogout(request: Request, env: Env): Promise<Response> {
	// Extract the cookie header
	const cookieHeader = request.headers.get('Cookie');

	// Parse the cookies to find the session ID
	let sessionId = null;
	if (cookieHeader) {
		const cookies = cookieHeader.split(';').map(cookie => cookie.trim());
		const sessionCookie = cookies.find(cookie => cookie.startsWith('cfw_session='));
		if (sessionCookie) {
			sessionId = sessionCookie.split('=')[1];
		}
	}

	if (sessionId) {
		// Call the session deletion endpoint of the other worker
		const deleteSessionUrl = `https://session-state.d1.compact.workers.dev/delete/${sessionId}`;
		const deleteRequest = new Request(deleteSessionUrl, { method: 'DELETE' });
		await env.sessionService.fetch(deleteRequest);
	}

	// Clear the session cookie in the response
	const headers = new Headers({
		'Set-Cookie': 'cfw_session=; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
	});

	return new Response(JSON.stringify({ message: 'Logout successful' }), { headers });
}

// Placeholder for initiating the password reset process.
async function handleForgotPassword(request: Request, env: Env): Promise<Response> {
	const { email } = await request.json() as { email: string };
	// Initiate password reset process
	// TODO - Implement the password reset process.
	return new Response(JSON.stringify({ message: 'Password reset initiated' }));
}


// Implement a function to hash passwords
// While best practice is to use a slow hashing algorithm like bcrypt, doing so in a Worker is not practical.
async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16)).join('');
	const data = new TextEncoder().encode(salt + password);
	const hashBuffer = await crypto.subtle.digest({ name: hashingAlgo }, data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	return `${salt}:${hashHex}`;
}

// Compares a provided password against a stored hash to authenticate a user.
async function comparePassword(providedPassword: string, storedHash: string): Promise<boolean> {
	// Split the stored hash to extract the salt and the actual hash
	const [salt, originalHash] = storedHash.split(':');

	// Hash the provided password with the extracted salt
	const data = new TextEncoder().encode(salt + providedPassword);
	const hashBuffer = await crypto.subtle.digest({ name: hashingAlgo }, data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

	// Compare the newly generated hash with the original hash
	return hashHex === originalHash;
}

// Handles CORS preflight requests by setting appropriate headers.
function handleOptions(request: Request): Response {
	// Make sure the necessary headers are present
	// for this to be a valid pre-flight request
	let headers = request.headers;
	if (
		headers.get("Origin") !== null &&
		headers.get("Access-Control-Request-Method") !== null &&
		headers.get("Access-Control-Request-Headers") !== null
	) {
		// Handle CORS pre-flight request.
		let respHeaders: { [key: string]: string } = {
			...corsHeaders,
			"Access-Control-Allow-Headers": headers.get("Access-Control-Request-Headers") || "",
		};
		respHeaders["Content-Type"] = "text/plain";
		respHeaders["X-Content-Type-Options"] = "nosniff";
		respHeaders["Access-Control-Allow-Origin"] = getValidatedOrigin(request) || "*";
		return new Response(null, {
			headers: respHeaders,
		});
	} else {
		// Handle standard OPTIONS request.
		return new Response(null, {
			headers: {
				"Allow": "GET, HEAD, POST, OPTIONS",
				"Content-Type": "text/plain"
			},
		});
	}
}

// Validates the origin of a request to enforce CORS policy.
// This is a basic example and should be extended to include a list of allowed origins.
function getValidatedOrigin(request: Request): string | null {
	const origin = request.headers.get("Origin");
	if (origin === null) {
		return null;
	}
	const url = new URL(origin);
	if (url.protocol === "http:" || url.protocol === "https:") {
		// You could also validate the hostname against a list of allowed known good origins.
		return origin;
	} else {
		return null;
	}
}

// Defines the structure for user credentials.
interface Credentials {
	username: string;
	password: string;
}

// Extends Credentials with additional registration data.
interface RegistrationData extends Credentials {
	firstName: string;
	lastName: string;
}