using Microsoft.AspNetCore.Mvc;

namespace Regatta.Api.Controllers
{
    [ApiController]
    [Route("weather/v1")]
    public class WeatherController : ControllerBase
    {
        [HttpGet("wind")]
        public IActionResult Wind()
        {
            return Ok();
        }

        [HttpGet("tide")]
        public IActionResult Tide()
        {
            return Ok();
        }
    }
}
