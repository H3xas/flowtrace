using Microsoft.AspNetCore.Mvc;

namespace Ferry.Gateway.Controllers
{
    [ApiController]
    [Route("boats")]
    public class BoatsController : ControllerBase
    {
        [HttpGet("{boatId}")]
        public IActionResult Get(string boatId)
        {
            return Ok();
        }
    }
}
