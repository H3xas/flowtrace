using Microsoft.AspNetCore.Mvc;

namespace Ferry.Gateway.Controllers
{
    [ApiController]
    [Route("cargo")]
    public class CargoController : ControllerBase
    {
        [HttpPost]
        public IActionResult Load()
        {
            return Ok();
        }
    }
}
