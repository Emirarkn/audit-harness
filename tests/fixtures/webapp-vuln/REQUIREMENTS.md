# REQUIREMENTS.md

## Project
- **Name:** ShopLite
- **One-line purpose:** Small online shop backend where Turkish consumers sign up and view their orders.
- **Type:** web app/API
- **Users / audience:** public Turkish consumers
- **Deployment target:** single Node.js server

## Functional requirements
- R1: Users sign up with email and password; passwords are stored with bcrypt.
- R2: Users log in and receive a JWT that expires within 24 hours.
- R3: A logged-in user can see only their own orders.
- R4: The admin dashboard is accessible only to users with the admin role.
- R5: Users can reset a forgotten password via an emailed link.
- R6: The signup page shows the KVKK aydınlatma metni, and marketing consent is an unticked, optional checkbox.
- R7: Users can export their own data as CSV.

## Data & privacy
- Personal data collected: email, full name, phone, order history
- Third-party services receiving data: none
- Privacy notice location: public/privacy.html
