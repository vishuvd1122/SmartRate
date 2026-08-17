// This middleware will receive the response from the assigned algorithm and then it will dettermine wether that the request will be allowed or not.

// This should return the express middleware.

class RateLimiter {
  //This class is responsible to connect the rateLimite to express.
  constructor(algorithm){
    this.algorithm = algorithm
  }

middleware (){

    return async(req,res,next)=>{
    try{
    const identifier = req.ip;
    const result = await this.algorithm.check(identifier); // this is the response from the algorithm logic

    // set the headers
    res.setHeader("X-RateLimit-Limit", result.limit);
    res.setHeader("X-RateLimit-Remaining",result.remaining);
    res.setHeader("X-RateLimit-Reset",Math.floor(result.resetAt / 1000));

    if (result.allowed == true){
      return next()
    }

    const retryAfter = Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000));

    res.setHeader("Retry-After", retryAfter);    

    return res.status(429).json({
      message: "Too many requests, please try again later.",
      retryAfter: retryAfter
    })

  }
  catch (error) {
        // FIX 2: Now 'next' is actually in scope to handle the error
        console.error("Rate Limiter Error:", error);
        return next(error);
      }
    }
    
  }
}


module.exports = RateLimiter
