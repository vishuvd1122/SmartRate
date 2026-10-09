- In the current structure, if the user want to implement some other identifier other than the IP, they need to pass the key generater as an arrow function. 
 keyGenerator: (req) => (req.user ? `user:${req.user.id}` : `ip:${req.ip}`),
Plan to improve this and do something like the user just writes user.id. This will be very user friendly.